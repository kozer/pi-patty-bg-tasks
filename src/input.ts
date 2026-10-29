// src/input.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";
import type { UiContext } from "./types.ts";
import { backgroundActiveForeground } from "./lifecycle.ts";

/** Input starting with this waits for the current step (pi's plain steer). */
export const GENTLE_PREFIX = "+";
const IDLE_WAIT_MS = 15_000;

type Image = { type: "image"; data: string; mimeType: string };
type IdleContext = { isIdle(): boolean };

export function registerInputHandlers(pi: ExtensionAPI, reg: BackgroundRegistry): void {
    pi.on("input", async (event, ctx) => {
        // Don't intercept extension-sourced messages.
        if (event.source === "extension") return { action: "continue" };
        const text = event.text.trim();
        if (text.startsWith("/")) return { action: "continue" };
        if (text.startsWith(GENTLE_PREFIX) && event.streamingBehavior === "steer") {
            return {
                action: "transform",
                text: text.slice(GENTLE_PREFIX.length).trim(),
                images: event.images,
            };
        }
        const content = withImages(event.text, event.images);

        // Cooperative steering (Claude Code parity): ANY input typed while a
        // foreground bash command is running backgrounds that command and
        // re-delivers the input as a steer — regardless of the message's
        // steer/followUp streamingBehavior.
        if (reg.foreground.size > 0 && backgroundActiveForeground(reg, ctx as UiContext)) {
            // No ctx.abort() (see takeControl): backgrounding already makes the bash
            // tool return, and aborting would end the run with the follow-up stuck in
            // pi's queue, never sent. A steer lands as soon as the tool batch returns.
            try {
                pi.sendUserMessage(content, { deliverAs: "steer" });
            } catch {
                // Session ended before resubmit — nothing to deliver to.
            }
            return { action: "handled" };
        }

        // Interrupting steer: pi takes a steer only after the current response and
        // its whole tool batch finish. Enter while the model works with no
        // foreground command interrupts like Esc and sends the message next.
        // Alt+Enter (followUp) keeps pi's queueing.
        if (event.source !== "interactive" || event.streamingBehavior !== "steer") {
            return { action: "continue" };
        }
        ctx.abort();
        void untilIdle(ctx).then((idle) => {
            try {
                // If the abort never settles, fall back to a steer rather than drop it.
                pi.sendUserMessage(content, idle ? undefined : { deliverAs: "steer" });
            } catch {
                // Session ended before resubmit — nothing to deliver to.
            }
        });
        return { action: "handled" };
    });
}

function withImages(text: string, images: Image[] | undefined) {
    return images?.length ? [{ type: "text" as const, text }, ...images] : text;
}

export async function untilIdle(ctx: IdleContext): Promise<boolean> {
    const deadline = Date.now() + IDLE_WAIT_MS;
    while (!ctx.isIdle()) {
        if (Date.now() > deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
}
