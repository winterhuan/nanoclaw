import { log } from '../log.js';
import { readEnvFile } from '../env.js';
import { WSClient, EventDispatcher, Client as LarkClient } from '@larksuiteoapi/node-sdk';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

export function createFeishuAdapter(): ChannelAdapter | null {
  const env = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) return null;

  let config: ChannelSetup | null = null;
  let wsClient: WSClient | null = null;
  let larkClient: any = null;
  let connected = false;
  let botOpenId: string | null = null;

  const adapter: ChannelAdapter = {
    name: 'feishu',
    channelType: 'feishu',
    supportsThreads: true,

    async setup(setupConfig: ChannelSetup): Promise<void> {
      config = setupConfig;

      const dispatcher = new EventDispatcher({}).register({
        'im.message.receive_v1': async (data: any) => {
          const msg = data.message;
          const sender = data.sender;
          const isGroup = msg.chat_type === 'group';
          const isDm = msg.chat_type === 'p2p';

          let content: Record<string, unknown> = {};
          if (msg.message_type === 'text') {
            try {
              content = { text: JSON.parse(msg.content).text, senderId: sender.sender_id.open_id };
            } catch { content = { text: msg.content, senderId: sender.sender_id.open_id }; }
          } else if (msg.message_type === 'image') {
            try {
              const parsed = JSON.parse(msg.content);
              content = { text: '[image]', senderId: sender.sender_id.open_id, imageKey: parsed.file_key };
            } catch {
              content = { text: '[image]', senderId: sender.sender_id.open_id };
            }
          } else {
            try {
              const parsed = JSON.parse(msg.content);
              content = { text: `[${msg.message_type}]`, senderId: sender.sender_id.open_id, ...parsed };
            } catch {
              content = { text: `[${msg.message_type}]`, senderId: sender.sender_id.open_id };
            }
          }

          // Resolve mention placeholders (@_user_N → @RealName) and detect bot mention
          const mentions: Array<{ key: string; id: { open_id: string }; name: string }> = msg.mentions ?? [];
          let isMention = isDm;
          for (const m of mentions) {
            if (typeof content.text === 'string') {
              content.text = (content.text as string).replace(m.key, `@${m.name}`);
            }
            if (m.id.open_id === botOpenId) {
              isMention = true;
            }
          }

          const threadId = msg.parent_id || null;

          config!.onInbound(
            `feishu:${msg.chat_id}`,
            threadId,
            {
              id: msg.message_id,
              kind: 'chat' as const,
              content,
              timestamp: new Date().toISOString(),
              isMention,
              isGroup,
            },
          );

          config!.onMetadata(`feishu:${msg.chat_id}`, undefined, isGroup);
        },
      });

      wsClient = new WSClient({
        appId: env.FEISHU_APP_ID!,
        appSecret: env.FEISHU_APP_SECRET!,
        loggerLevel: process.env.NODE_ENV === 'test' ? 0 as any : undefined,
      });

      larkClient = new LarkClient({
        appId: env.FEISHU_APP_ID!,
        appSecret: env.FEISHU_APP_SECRET!,
      });

      // Cache bot's own open_id for mention detection
      try {
        const botResp = await larkClient.request({
          method: 'GET',
          url: '/open-apis/bot/v3/info/',
        });
        botOpenId = botResp?.bot?.open_id ?? botResp?.data?.bot?.open_id ?? null;
        if (botOpenId) log.info('Feishu bot open_id cached', { botOpenId });
      } catch (err: any) {
        log.warn('Feishu: failed to fetch bot info', { error: err?.message ?? err });
      }

      // Card action handler — separate from EventDispatcher
      // The SDK routes card.action callbacks through the WSClient's eventDispatcher
      // We add it to the same dispatcher for simplicity
      dispatcher.register({
        'card.action': async (data: any) => {
          const questionId = data.action?.value?.questionId;
          const optionId = data.action?.value?.optionId;
          const userId = data.open_id;
          if (questionId && optionId && userId) {
            config!.onAction(questionId, optionId, userId);
          }
        },
      } as any);

      await wsClient.start({ eventDispatcher: dispatcher });
      connected = true;
      log.info('Feishu adapter ready (WebSocket)');
    },

    async teardown(): Promise<void> {
      connected = false;
      config = null;
      wsClient?.close();
      wsClient = null;
      larkClient = null;
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(
      platformId: string,
      _threadId: string | null,
      message: OutboundMessage,
    ): Promise<string | undefined> {
      if (!larkClient) return undefined;

      const chatId = platformId.replace('feishu:', '');

      if (message.kind === 'chat') {
        const text = (message.content as any)?.text ?? '';

        let lastTextMsgId: string | undefined;
        if (text) {
          const hasFormatting = /[*`\[]/.test(text);
          if (hasFormatting) {
            const post = markdownToFeishuPost(text);
            const resp = await larkClient.im.message.create({
              data: { receive_id: chatId, msg_type: 'post', content: JSON.stringify(post) },
              params: { receive_id_type: 'chat_id' },
            });
            lastTextMsgId = resp.data?.message_id;
          } else {
            const resp = await larkClient.im.message.create({
              data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
              params: { receive_id_type: 'chat_id' },
            });
            lastTextMsgId = resp.data?.message_id;
          }
        }

        if (message.files && message.files.length > 0) {
          let lastMsgId: string | undefined;
          for (const file of message.files) {
            const isImage = /\.(png|jpe?g|gif|bmp|webp)$/i.test(file.filename);
            const uploadResp = await larkClient.im.file.create({
              data: { file_type: isImage ? 'image' : 'stream', file_name: file.filename },
            });
            const fileKey = uploadResp.data?.file_key;
            if (!fileKey) continue;

            const sendResp = await larkClient.im.message.create({
              data: {
                receive_id: chatId,
                msg_type: isImage ? 'image' : 'file',
                content: JSON.stringify({ file_key: fileKey }),
              },
              params: { receive_id_type: 'chat_id' },
            });
            lastMsgId = sendResp.data?.message_id;
          }
          return lastMsgId;
        }

        return lastTextMsgId;
      }

      if (message.kind === 'ask_user_question') {
        const q = message.content as any;
        const question = q.question ?? '';
        const options: Array<{ id: string; label: string }> = q.options ?? [];

        const card = {
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: question }, template: 'blue' },
          elements: [
            {
              tag: 'action',
              actions: options.map((opt) => ({
                tag: 'button',
                text: { tag: 'plain_text', content: opt.label },
                type: 'primary',
                value: { questionId: q.questionId ?? q.id, optionId: opt.id },
              })),
            },
          ],
        };

        const resp = await larkClient.im.message.create({
          data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
          params: { receive_id_type: 'chat_id' },
        });
        return resp.data?.message_id;
      }

      return undefined;
    },

    async openDM(userHandle: string): Promise<string> {
      if (!larkClient) throw new Error('Feishu adapter not initialized');

      const resp = await larkClient.im.message.create({
        data: {
          receive_id: userHandle,
          msg_type: 'text',
          content: JSON.stringify({ text: '' }),
        },
        params: { receive_id_type: 'open_id' },
      });

      const chatId = (resp.data as any)?.chat_id ?? (resp as any)?.chat_id;
      return `feishu:${chatId ?? userHandle}`;
    },
  };

  return adapter;
}

registerChannelAdapter('feishu', { factory: createFeishuAdapter });

/** Convert markdown-ish text to Feishu post (rich text) schema. */
function markdownToFeishuPost(text: string): { zh_cn: { title: string; content: Array<Array<Record<string, unknown>>> } } {
  const lines = text.split('\n');
  const content: Array<Array<Record<string, unknown>>> = [];

  for (const line of lines) {
    const elements: Array<Record<string, unknown>> = [];
    let remaining = line;

    while (remaining.length > 0) {
      const boldMatch = remaining.match(/^(.*?)\*\*(.+?)\*\*/);
      const codeMatch = remaining.match(/^(.*?)`([^`]+)`/);
      const linkMatch = remaining.match(/^(.*?)\[([^\]]+)\]\(([^)]+)\)/);

      const candidates = [
        boldMatch ? { idx: boldMatch[1].length, len: boldMatch[0].length } : null,
        codeMatch ? { idx: codeMatch[1].length, len: codeMatch[0].length } : null,
        linkMatch ? { idx: linkMatch[1].length, len: linkMatch[0].length } : null,
      ].filter(Boolean).sort((a, b) => a!.idx - b!.idx);

      if (candidates.length === 0 || (candidates[0]!.idx === remaining.length)) {
        elements.push({ tag: 'text', text: remaining });
        break;
      }

      const first = candidates[0]!;
      if (first.idx > 0) {
        elements.push({ tag: 'text', text: remaining.slice(0, first.idx) });
      }

      if (boldMatch && first.idx === boldMatch[1].length) {
        elements.push({ tag: 'text', text: boldMatch[2], style: ['bold'] });
        remaining = remaining.slice(first.idx + first.len);
      } else if (codeMatch && first.idx === codeMatch[1].length) {
        elements.push({ tag: 'text', text: codeMatch[2], style: ['code_inline'] });
        remaining = remaining.slice(first.idx + first.len);
      } else if (linkMatch && first.idx === linkMatch[1].length) {
        elements.push({ tag: 'a', text: linkMatch[2], href: linkMatch[3] });
        remaining = remaining.slice(first.idx + first.len);
      } else {
        break;
      }
    }

    content.push(elements);
  }

  return { zh_cn: { title: '', content } };
}
