// src/telegram.ts
//
// The same input steering for messages from @llblab/pi-telegram, which never
// reach pi's input event: pi-telegram queues a message sent while pi works until
// the run ends. While pi works, a text from the owner now backgrounds the running
// foreground command and steers in, or (with no command) interrupts the run and
// is left to pi-telegram, which starts it as the next Telegram turn. A voice note
// or photo backgrounds the command and interrupts the run. Active only
// when PI_TELEGRAM_BOT is set, i.e. when pi-telegram runs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";
import type { UiContext } from "./types.ts";
import { backgroundActiveForeground } from "./lifecycle.ts";
import { GENTLE_PREFIX } from "./input.ts";

// pi-telegram's raw-update interop contract (v1), shared through globalThis so
// either side may create it. Handlers run before pi-telegram authorises the
// sender; "consume" ends handling, "pass" (or a throw) lets pi-telegram go on.
const REGISTRY_KEY = "__piTelegramUpdateHandlerRegistry__";
const PREFIX = "[telegram]";

type Verdict = "consume" | "pass";
export type TelegramUpdate = {
    message?: {
        message_id: number;
        chat: { id: number; type: string };
        from?: { id: number };
        text?: string;
    };
};
type Handler = (update: TelegramUpdate) => Promise<Verdict> | Verdict;
type Registry = {
    version: 1;
    add(handler: Handler): () => void;
    dispatch(update: TelegramUpdate): Promise<Verdict>;
};

export function registerTelegramSteering(pi: ExtensionAPI, reg: BackgroundRegistry): void {
    let ctx: ExtensionContext | undefined;
    let dispose: (() => void) | undefined;

    pi.on("session_start", async (_event, c) => {
        ctx = c;
        const token = process.env.PI_TELEGRAM_BOT;
        if (dispose || !token) return;
        const owner = ownerId();
        if (owner === undefined) return; // pi-telegram not set up: it queues as usual
        dispose = telegramRegistry().add(
            telegramHandler({
                owner,
                context: () => ctx,
                background: (c) => reg.foreground.size > 0 && backgroundActiveForeground(reg, c as UiContext),
                steer: (text) => pi.sendUserMessage(`${PREFIX} ${text}`, { deliverAs: "steer" }),
                react: (chatId, messageId) => react(token, chatId, messageId),
            })
        );
    });

    pi.on("session_shutdown", async () => {
        dispose?.();
        dispose = undefined;
        ctx = undefined;
    });
}

export function telegramHandler(deps: {
    owner: number;
    context(): ExtensionContext | undefined;
    background(ctx: ExtensionContext): boolean;
    steer(text: string): void;
    react(chatId: number, messageId: number): void;
}): Handler {
    return (update) => {
        const m = update.message;
        if (!m || m.chat.type !== "private" || m.from?.id !== deps.owner) return "pass";
        const text = m.text?.trim() ?? "";
        if (text.startsWith("/")) return "pass"; // pi-telegram commands such as /abort
        const ctx = deps.context();
        if (!ctx || ctx.isIdle()) return "pass"; // idle: pi-telegram starts a normal turn

        if (m.text === undefined) {
            // Voice notes and photos need pi-telegram to fetch them, so they can't
            // steer in: keep a running command alive in the background, then
            // interrupt so pi-telegram starts the note as the next turn.
            deps.background(ctx);
            ctx.abort();
            return "pass";
        }
        const gentle = text.startsWith(GENTLE_PREFIX);
        if (gentle || deps.background(ctx)) {
            try {
                deps.steer(gentle ? text.slice(GENTLE_PREFIX.length).trim() : text);
            } catch {
                return "pass"; // let pi-telegram queue it instead
            }
            // pi-telegram never sees a consumed message, so acknowledge it here.
            deps.react(m.chat.id, m.message_id);
            return "consume";
        }
        // Interrupt, then let pi-telegram queue the message: it starts it as the
        // next Telegram turn once the run stops.
        ctx.abort();
        return "pass";
    };
}

function telegramRegistry(): Registry {
    const g = globalThis as Record<string, unknown>;
    const existing = g[REGISTRY_KEY] as Registry | undefined;
    if (existing?.version === 1 && typeof existing.add === "function" && typeof existing.dispatch === "function") {
        return existing;
    }
    const handlers = new Set<Handler>();
    const registry: Registry = {
        version: 1,
        add(handler) {
            handlers.add(handler);
            return () => handlers.delete(handler);
        },
        async dispatch(update) {
            for (const handler of handlers) {
                try {
                    if ((await handler(update)) === "consume") return "consume";
                } catch {
                    // Update handler errors must not break polling.
                }
            }
            return "pass";
        },
    };
    g[REGISTRY_KEY] = registry;
    return registry;
}

function ownerId(): number | undefined {
    try {
        const conf = JSON.parse(readFileSync(join(getAgentDir(), "telegram.json"), "utf8"));
        const id = Number(conf?.profiles?.default?.allowedUserId);
        return Number.isFinite(id) ? id : undefined;
    } catch {
        return undefined;
    }
}

function react(token: string, chatId: number, messageId: number): void {
    fetch(`https://api.telegram.org/bot${token}/setMessageReaction`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            reaction: [{ type: "emoji", emoji: "👀" }],
        }),
    }).catch(() => {});
}
