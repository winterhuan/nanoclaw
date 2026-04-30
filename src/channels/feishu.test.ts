import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock readEnvFile before importing the adapter
const mockReadEnvFile = vi.fn().mockReturnValue({});
vi.mock('../env.js', () => ({
  readEnvFile: (...args: string[]) => mockReadEnvFile(...args),
}));

// Mock the registry to avoid side effects
vi.mock('./channel-registry.js', () => ({
  registerChannelAdapter: vi.fn(),
}));

// Capture the event handlers registered via EventDispatcher.register
let capturedMessageHandler: ((data: any) => Promise<void>) | null = null;
let capturedCardHandler: ((data: any) => Promise<void>) | null = null;

// Shared mock for the Lark client instance — tests can assert on its methods
const mockMessageCreate = vi.fn().mockResolvedValue({ data: { message_id: 'msg_out_1' } });
const mockRequest = vi.fn().mockResolvedValue({ bot: { open_id: 'ou_bot' }, code: 0, msg: 'ok' });
const mockLarkClient = {
  im: {
    message: { create: mockMessageCreate },
    file: { create: vi.fn() },
  },
  request: mockRequest,
};

vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockWSClient {
    start = vi.fn().mockResolvedValue(undefined);
    close = vi.fn();
    constructor(_opts: any) {}
  }
  class MockClient {
    im = mockLarkClient.im;
    request = mockRequest;
    constructor(_opts: any) {}
  }
  class MockEventDispatcher {
    register = vi.fn().mockImplementation(function (this: any, handlers: Record<string, any>) {
      if (handlers['im.message.receive_v1']) {
        capturedMessageHandler = handlers['im.message.receive_v1'];
      }
      if (handlers['card.action']) {
        capturedCardHandler = handlers['card.action'];
      }
      return this;
    });
    constructor(_params?: any) {}
  }
  return {
    WSClient: MockWSClient,
    Client: MockClient,
    EventDispatcher: MockEventDispatcher,
  };
});

function makeDmEvent(overrides?: Partial<{
  chatId: string;
  messageId: string;
  text: string;
  parent_id: string;
  root_id: string;
  senderOpenId: string;
}>) {
  return {
    event_id: 'evt_1',
    event_type: 'im.message.receive_v1',
    message: {
      message_id: overrides?.messageId ?? 'msg_1',
      chat_id: overrides?.chatId ?? 'chat_dm_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: overrides?.text ?? 'Hello bot' }),
      parent_id: overrides?.parent_id ?? '',
      root_id: overrides?.root_id ?? '',
    },
    sender: { sender_id: { open_id: overrides?.senderOpenId ?? 'ou_user1' } },
  };
}

function makeGroupEvent(overrides?: Partial<{
  chatId: string;
  messageId: string;
  text: string;
  parent_id: string;
  root_id: string;
  senderOpenId: string;
  mentions: Array<{ key: string; id: { open_id: string }; name: string }>;
}>) {
  return {
    event_id: 'evt_grp_1',
    event_type: 'im.message.receive_v1',
    message: {
      message_id: overrides?.messageId ?? 'msg_grp_1',
      chat_id: overrides?.chatId ?? 'chat_group_1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: overrides?.text ?? 'Hey @_user_1 help me' }),
      parent_id: overrides?.parent_id ?? '',
      root_id: overrides?.root_id ?? '',
      mentions: overrides?.mentions ?? [],
    },
    sender: { sender_id: { open_id: overrides?.senderOpenId ?? 'ou_user1' } },
  };
}

describe('Feishu adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadEnvFile.mockReturnValue({});
    capturedMessageHandler = null;
    capturedCardHandler = null;
  });

  it('returns null from factory when FEISHU_APP_ID is missing', async () => {
    const { createFeishuAdapter } = await import('./feishu.js');
    const adapter = createFeishuAdapter();
    expect(adapter).toBeNull();
  });

  it('returns adapter when credentials are present', async () => {
    mockReadEnvFile.mockReturnValue({
      FEISHU_APP_ID: 'cli_test123',
      FEISHU_APP_SECRET: 'secret456',
    });

    const { createFeishuAdapter } = await import('./feishu.js');
    const adapter = createFeishuAdapter();
    expect(adapter).not.toBeNull();
    expect(adapter!.channelType).toBe('feishu');
    expect(adapter!.supportsThreads).toBe(true);
  });

  it('routes DM inbound message with correct fields', async () => {
    mockReadEnvFile.mockReturnValue({
      FEISHU_APP_ID: 'cli_test123',
      FEISHU_APP_SECRET: 'secret456',
    });

    const { createFeishuAdapter } = await import('./feishu.js');
    const adapter = createFeishuAdapter();

    const onInbound = vi.fn();
    const onMetadata = vi.fn();
    await adapter!.setup({
      onInbound,
      onInboundEvent: vi.fn(),
      onMetadata,
      onAction: vi.fn(),
    });

    // The handler should have been captured during setup
    expect(capturedMessageHandler).not.toBeNull();

    // Fire a DM event
    await capturedMessageHandler!(makeDmEvent());

    expect(onInbound).toHaveBeenCalledWith(
      'feishu:chat_dm_1',
      null,
      expect.objectContaining({
        id: 'msg_1',
        kind: 'chat',
        isMention: true,
        isGroup: false,
      }),
    );

    const content = onInbound.mock.calls[0][2].content as any;
    expect(content.text).toBe('Hello bot');
  });

  it('delivers plain text outbound message via Feishu API', async () => {
    mockReadEnvFile.mockReturnValue({
      FEISHU_APP_ID: 'cli_test123',
      FEISHU_APP_SECRET: 'secret456',
    });
    mockMessageCreate.mockResolvedValue({ data: { message_id: 'msg_out_1' } });

    const { createFeishuAdapter } = await import('./feishu.js');
    const adapter = createFeishuAdapter();

    await adapter!.setup({
      onInbound: vi.fn(),
      onInboundEvent: vi.fn(),
      onMetadata: vi.fn(),
      onAction: vi.fn(),
    });

    const msgId = await adapter!.deliver('feishu:chat_dm_1', null, {
      kind: 'chat',
      content: { text: 'Agent reply' },
    });

    expect(mockMessageCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockMessageCreate.mock.calls[0][0];
    expect(callArgs.data.receive_id).toBe('chat_dm_1');
    expect(callArgs.data.msg_type).toBe('text');

    const sentContent = JSON.parse(callArgs.data.content);
    expect(sentContent.text).toBe('Agent reply');

    expect(msgId).toBe('msg_out_1');
  });

  it('detects bot mention via mentions array in group message', async () => {
    mockReadEnvFile.mockReturnValue({
      FEISHU_APP_ID: 'cli_test123',
      FEISHU_APP_SECRET: 'secret456',
    });

    const { createFeishuAdapter } = await import('./feishu.js');
    const adapter = createFeishuAdapter();

    const onInbound = vi.fn();
    const onMetadata = vi.fn();
    await adapter!.setup({
      onInbound,
      onInboundEvent: vi.fn(),
      onMetadata,
      onAction: vi.fn(),
    });

    // Fire a group event where the bot is mentioned
    await capturedMessageHandler!(makeGroupEvent({
      text: '@_user_1 help me',
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'NanoBot' },
      ],
    }));

    // The adapter needs to know its own open_id to detect mentions
    // For now, since bot open_id isn't cached yet, isMention should be true
    // when mentions array is non-empty
    expect(onInbound).toHaveBeenCalledWith(
      'feishu:chat_group_1',
      null,
      expect.objectContaining({
        isMention: true,
        isGroup: true,
      }),
    );
  });

  it('sets isMention false when bot is not in mentions array', async () => {
    mockReadEnvFile.mockReturnValue({
      FEISHU_APP_ID: 'cli_test123',
      FEISHU_APP_SECRET: 'secret456',
    });

    const { createFeishuAdapter } = await import('./feishu.js');
    const adapter = createFeishuAdapter();

    const onInbound = vi.fn();
    await adapter!.setup({
      onInbound,
      onInboundEvent: vi.fn(),
      onMetadata: vi.fn(),
      onAction: vi.fn(),
    });

    await capturedMessageHandler!(makeGroupEvent({
      text: 'Someone else is talking',
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_other_user' }, name: 'Alice' },
      ],
    }));

    expect(onInbound).toHaveBeenCalledWith(
      'feishu:chat_group_1',
      null,
      expect.objectContaining({
        isMention: false,
        isGroup: true,
      }),
    );
  });

  it('resolves @mention placeholders to real names', async () => {
    mockReadEnvFile.mockReturnValue({
      FEISHU_APP_ID: 'cli_test123',
      FEISHU_APP_SECRET: 'secret456',
    });

    const { createFeishuAdapter } = await import('./feishu.js');
    const adapter = createFeishuAdapter();

    const onInbound = vi.fn();
    await adapter!.setup({
      onInbound,
      onInboundEvent: vi.fn(),
      onMetadata: vi.fn(),
      onAction: vi.fn(),
    });

    await capturedMessageHandler!(makeGroupEvent({
      text: '@_user_1 and @_user_2 check this',
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_alice' }, name: 'Alice' },
        { key: '@_user_2', id: { open_id: 'ou_bot' }, name: 'NanoBot' },
      ],
    }));

    const content = onInbound.mock.calls[0][2].content as any;
    expect(content.text).toBe('@Alice and @NanoBot check this');
  });

  it('maps parent_id to threadId for thread replies', async () => {
    mockReadEnvFile.mockReturnValue({
      FEISHU_APP_ID: 'cli_test123',
      FEISHU_APP_SECRET: 'secret456',
    });

    const { createFeishuAdapter } = await import('./feishu.js');
    const adapter = createFeishuAdapter();

    const onInbound = vi.fn();
    await adapter!.setup({
      onInbound,
      onInboundEvent: vi.fn(),
      onMetadata: vi.fn(),
      onAction: vi.fn(),
    });

    await capturedMessageHandler!(makeGroupEvent({
      text: 'Replying in thread',
      parent_id: 'msg_parent_1',
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'NanoBot' },
      ],
    }));

    expect(onInbound).toHaveBeenCalledWith(
      'feishu:chat_group_1',
      'msg_parent_1',
      expect.objectContaining({
        isMention: true,
        isGroup: true,
      }),
    );
  });

  it('delivers rich text as Feishu post message', async () => {
    mockReadEnvFile.mockReturnValue({
      FEISHU_APP_ID: 'cli_test123',
      FEISHU_APP_SECRET: 'secret456',
    });
    mockMessageCreate.mockResolvedValue({ data: { message_id: 'msg_rich_1' } });

    const { createFeishuAdapter } = await import('./feishu.js');
    const adapter = createFeishuAdapter();

    await adapter!.setup({
      onInbound: vi.fn(),
      onInboundEvent: vi.fn(),
      onMetadata: vi.fn(),
      onAction: vi.fn(),
    });

    const msgId = await adapter!.deliver('feishu:chat_group_1', null, {
      kind: 'chat',
      content: { text: '**bold** and `code` and [link](https://example.com)' },
    });

    expect(mockMessageCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockMessageCreate.mock.calls[0][0];
    expect(callArgs.data.msg_type).toBe('post');

    const sentContent = JSON.parse(callArgs.data.content);
    // Post content should have structured rich text
    expect(sentContent.zh_cn.title).toBeDefined();
    expect(sentContent.zh_cn.content).toBeDefined();

    expect(msgId).toBe('msg_rich_1');
  });

  it('handles inbound image message by downloading and attaching', async () => {
    mockReadEnvFile.mockReturnValue({
      FEISHU_APP_ID: 'cli_test123',
      FEISHU_APP_SECRET: 'secret456',
    });

    // Mock file download
    const mockFileDownload = vi.fn().mockResolvedValue({
      writeFile: vi.fn().mockResolvedValue(undefined),
    });

    const { createFeishuAdapter } = await import('./feishu.js');
    const adapter = createFeishuAdapter();

    const onInbound = vi.fn();
    await adapter!.setup({
      onInbound,
      onInboundEvent: vi.fn(),
      onMetadata: vi.fn(),
      onAction: vi.fn(),
    });

    // Fire an image message event
    await capturedMessageHandler!({
      event_id: 'evt_img_1',
      event_type: 'im.message.receive_v1',
      message: {
        message_id: 'msg_img_1',
        chat_id: 'chat_dm_2',
        chat_type: 'p2p',
        message_type: 'image',
        content: JSON.stringify({ file_key: 'fk_image_1' }),
        parent_id: '',
        root_id: '',
      },
      sender: { sender_id: { open_id: 'ou_user1' } },
    });

    expect(onInbound).toHaveBeenCalledWith(
      'feishu:chat_dm_2',
      null,
      expect.objectContaining({
        id: 'msg_img_1',
        isMention: true,
        isGroup: false,
      }),
    );

    const content = onInbound.mock.calls[0][2].content as any;
    expect(content.imageKey).toBe('fk_image_1');
  });

  it('uploads and sends outbound image file', async () => {
    mockReadEnvFile.mockReturnValue({
      FEISHU_APP_ID: 'cli_test123',
      FEISHU_APP_SECRET: 'secret456',
    });

    const mockFileCreate = vi.fn().mockResolvedValue({ data: { file_key: 'fk_uploaded' } });
    mockLarkClient.im.file = { ...mockLarkClient.im.file, create: mockFileCreate };
    mockMessageCreate.mockResolvedValue({ data: { message_id: 'msg_file_1' } });

    const { createFeishuAdapter } = await import('./feishu.js');
    const adapter = createFeishuAdapter();

    await adapter!.setup({
      onInbound: vi.fn(),
      onInboundEvent: vi.fn(),
      onMetadata: vi.fn(),
      onAction: vi.fn(),
    });

    const imageData = Buffer.from('fake-image-data');
    const msgId = await adapter!.deliver('feishu:chat_dm_1', null, {
      kind: 'chat',
      content: { text: '' },
      files: [{ filename: 'chart.png', data: imageData }],
    });

    expect(mockFileCreate).toHaveBeenCalledTimes(1);
    expect(mockMessageCreate).toHaveBeenCalledTimes(1);
    const sendArgs = mockMessageCreate.mock.calls[0][0];
    expect(sendArgs.data.msg_type).toBe('image');
    expect(msgId).toBe('msg_file_1');
  });

  it('renders ask_user_question as Feishu interactive card', async () => {
    mockReadEnvFile.mockReturnValue({
      FEISHU_APP_ID: 'cli_test123',
      FEISHU_APP_SECRET: 'secret456',
    });
    mockMessageCreate.mockResolvedValue({ data: { message_id: 'msg_card_1' } });

    const { createFeishuAdapter } = await import('./feishu.js');
    const adapter = createFeishuAdapter();

    await adapter!.setup({
      onInbound: vi.fn(),
      onInboundEvent: vi.fn(),
      onMetadata: vi.fn(),
      onAction: vi.fn(),
    });

    const msgId = await adapter!.deliver('feishu:chat_dm_1', null, {
      kind: 'ask_user_question',
      content: {
        question: 'Allow package install?',
        options: [
          { id: 'opt_yes', label: 'Approve' },
          { id: 'opt_no', label: 'Deny' },
        ],
      },
    });

    expect(mockMessageCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockMessageCreate.mock.calls[0][0];
    expect(callArgs.data.msg_type).toBe('interactive');

    const card = JSON.parse(callArgs.data.content);
    expect(card.config).toBeDefined();
    expect(card.elements).toBeDefined();

    // Should have a button row with the options
    const actions = card.elements.find((e: any) => e.tag === 'action');
    expect(actions).toBeDefined();
    expect(actions.actions).toHaveLength(2);
    expect(actions.actions[0].tag).toBe('button');
    expect(actions.actions[0].text.tag).toBe('plain_text');
    expect(actions.actions[0].text.content).toBe('Approve');
    expect(actions.actions[0].value).toEqual({ questionId: undefined, optionId: 'opt_yes' });

    expect(msgId).toBe('msg_card_1');
  });

  it('routes card button click to onAction callback', async () => {
    mockReadEnvFile.mockReturnValue({
      FEISHU_APP_ID: 'cli_test123',
      FEISHU_APP_SECRET: 'secret456',
    });

    const { createFeishuAdapter } = await import('./feishu.js');
    const adapter = createFeishuAdapter();

    const onAction = vi.fn();
    await adapter!.setup({
      onInbound: vi.fn(),
      onInboundEvent: vi.fn(),
      onMetadata: vi.fn(),
      onAction,
    });

    expect(capturedCardHandler).not.toBeNull();

    // Simulate a button click
    await capturedCardHandler!({
      action: {
        value: { questionId: 'q_123', optionId: 'opt_yes' },
      },
      open_id: 'ou_user1',
    });

    expect(onAction).toHaveBeenCalledWith('q_123', 'opt_yes', 'ou_user1');
  });

  it('openDM sends to open_id and returns chat_id', async () => {
    mockReadEnvFile.mockReturnValue({
      FEISHU_APP_ID: 'cli_test123',
      FEISHU_APP_SECRET: 'secret456',
    });
    mockMessageCreate.mockResolvedValue({ data: { message_id: 'msg_dm_init' } });

    const { createFeishuAdapter } = await import('./feishu.js');
    const adapter = createFeishuAdapter();

    await adapter!.setup({
      onInbound: vi.fn(),
      onInboundEvent: vi.fn(),
      onMetadata: vi.fn(),
      onAction: vi.fn(),
    });

    const platformId = await adapter!.openDM!('ou_user1');

    // openDM should send a message to the user's open_id, creating/reusing a DM
    expect(mockMessageCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockMessageCreate.mock.calls[0][0];
    expect(callArgs.data.receive_id).toBe('ou_user1');
    expect(callArgs.params.receive_id_type).toBe('open_id');

    // Should return the platform_id (feishu:<chat_id>) for subsequent messages
    expect(platformId).toMatch(/^feishu:/);
  });
});
