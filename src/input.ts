// src/input.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";
import type { UiContext } from "./types.ts";
import { backgroundActiveForeground } from "./lifecycle.ts";

export function registerInputHandlers(pi: ExtensionAPI, reg: BackgroundRegistry): void {
    pi.on("input", async (event, ctx) => {
        // Cooperative steering (Claude Code parity): ANY input typed while a
        // foreground bash command is running backgrounds that command and
        // re-delivers the input as a steer — regardless of the message's
        // steer/followUp streamingBehavior. We only intercept when a foreground
        // slot is active; everything else falls through to Pi.
        if (reg.foreground.size === 0) return { action: "continue" };
        // Don't intercept extension-sourced messages.
        if (event.source === "extension") return { action: "continue" };

        const bg = backgroundActiveForeground(reg, ctx as UiContext);
        if (!bg) return { action: "continue" };

        // No ctx.abort() (see takeControl): backgrounding already makes the bash
        // tool return, and aborting would end the run with the follow-up stuck in
        // pi's queue, never sent. A steer lands as soon as the tool batch returns.
        const content = event.images?.length
            ? [{ type: "text" as const, text: event.text }, ...event.images]
            : event.text;
        try {
            pi.sendUserMessage(content, { deliverAs: "steer" });
        } catch {
            // Session ended before resubmit — nothing to deliver to.
        }

        return { action: "handled" };
    });
}
