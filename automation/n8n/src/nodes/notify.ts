/**
 * "ASTRA — Notify" sub-workflow: one message → the owner's channels. The channels are chosen in
 * "Channels (edit me)"; their secrets (bot token, webhook URL, SMTP password) live only in n8n
 * credentials. With no channel enabled the workflow stops with an error, which shows up in
 * ASTRA's live activity — alerts are never silently dropped.
 */
import { str, truncate, type Ctx, type Json } from './shared';

export interface Channels {
  readonly telegram: { readonly enabled: boolean; readonly chatId: string };
  readonly discord: { readonly enabled: boolean };
  readonly email: { readonly enabled: boolean; readonly from: string; readonly to: string };
}

// Enable at least one channel and create its credential in n8n (see automation/n8n/README.md).
const CHANNELS: Channels = {
  telegram: { enabled: false, chatId: '' },
  discord: { enabled: false },
  email: { enabled: false, from: '', to: '' },
};

export function checkChannels(c: Channels): Channels {
  if (!c.telegram.enabled && !c.discord.enabled && !c.email.enabled) {
    throw new Error(
      'No notification channel enabled: edit "Channels (edit me)" in "ASTRA — Notify" and add the matching credential.',
    );
  }
  if (c.telegram.enabled && !/^-?\d+$|^@\w{5,}$/.test(c.telegram.chatId)) {
    throw new Error('Telegram is enabled but chatId is not a chat id (a number) or @channel name');
  }
  const mail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (c.email.enabled && (!mail.test(c.email.from) || !mail.test(c.email.to))) {
    throw new Error('Email is enabled but "from" or "to" is not an email address');
  }
  return c;
}

const message = (m: Json) => ({
  title: truncate(str(m.title, 'ASTRA'), 200),
  text: str(m.text),
  level: str(m.level, 'INFO'),
});

/** "Channels (edit me)": validates the choice once and passes each message on with it. */
export function run(items: Json[], _ctx: Ctx): Json[] {
  const channels = checkChannels(CHANNELS);
  return items.map((m) => ({ ...message(m), channels }));
}

export function telegram(items: Json[], _ctx: Ctx): Json[] {
  return items.flatMap((m) => {
    const c = m.channels as Channels;
    return c.telegram.enabled
      ? [
          {
            chatId: c.telegram.chatId,
            text: truncate(`${String(m.title)}\n\n${String(m.text)}`, 4_000),
          },
        ]
      : [];
  });
}

export function discord(items: Json[], _ctx: Ctx): Json[] {
  return items.flatMap((m) => {
    const c = m.channels as Channels;
    return c.discord.enabled
      ? [{ content: truncate(`**${String(m.title)}**\n${String(m.text)}`, 1_990) }]
      : [];
  });
}

export function email(items: Json[], _ctx: Ctx): Json[] {
  return items.flatMap((m) => {
    const c = m.channels as Channels;
    return c.email.enabled
      ? [{ from: c.email.from, to: c.email.to, subject: String(m.title), text: String(m.text) }]
      : [];
  });
}
