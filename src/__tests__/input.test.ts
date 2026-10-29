import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerInputHandlers } from "../input.ts";
import { BackgroundRegistry } from "../state.ts";
import type { UiContext } from "../types.ts";

interface ResubmittedMessage {
    text: string;
    deliverAs?: string;
}

type InputHandler = (
    event: {
        type: "input";
        text: string;
        source: "interactive" | "rpc" | "extension";
        streamingBehavior?: "steer" | "followUp";
    },
    ctx: UiContext & {
        abort(): void;
        isIdle(): boolean;
        signal?: AbortSignal;
    }
) => Promise<
    | { action: "continue" }
    | { action: "transform"; text: string; images?: unknown }
    | { action: "handled" }
>;

void describe("input steering (cooperative scheduler)", () => {
    void it("backgrounds the job and resubmits the message as a steer without aborting", async () => {
        const reg = new BackgroundRegistry();
        const sent: { customType?: string }[] = [];
        const resubmitted: ResubmittedMessage[] = [];
        const notifications: string[] = [];
        let pauseReason: string | undefined;
        let abortCalled = false;
        const handler = registerAndGetHandler(reg, sent, resubmitted);
        reg.foreground.set("tc-steer", {
            requestPause: (reason) => {
                pauseReason = reason;
            },
        });

        const result = await handler(
            {
                type: "input",
                text: "stop and inspect the last failure",
                source: "interactive",
                streamingBehavior: "steer",
            },
            makeCtx(notifications, { abort: () => { abortCalled = true; } })
        );

        assert.equal(result.action, "handled");
        assert.equal(pauseReason, "manual");
        // Aborting would end the run with the resubmitted message stuck in the queue.
        assert.equal(abortCalled, false);
        // Steering suppresses the synthetic "backgrounded, continue working"
        // notice — the user's own resubmitted message drives the next turn,
        // so no redundant agent message is sent.
        assert.equal(sent.length, 0);
        assert.deepEqual(resubmitted, [
            { text: "stop and inspect the last failure", deliverAs: "steer" },
        ]);
    });

    void it("second input while still active does not double-background or double-resubmit", async () => {
        const reg = new BackgroundRegistry();
        const sent: { customType?: string }[] = [];
        const resubmitted: ResubmittedMessage[] = [];
        const notifications: string[] = [];
        let abortCalls = 0;
        const handler = registerAndGetHandler(reg, sent, resubmitted);
        reg.foreground.set("tc-steer2", {
            requestPause: () => {},
        });

        const r1 = await handler(
            { type: "input", text: "first", source: "interactive", streamingBehavior: "steer" },
            makeCtx(notifications, { abort: () => { abortCalls++; } })
        );
        const r2 = await handler(
            // Alt+Enter, so the interrupting steer (tested below) stays out of this case.
            { type: "input", text: "second", source: "interactive", streamingBehavior: "followUp" },
            makeCtx(notifications, { abort: () => { abortCalls++; } })
        );

        assert.equal(r1.action, "handled");
        assert.equal(r2.action, "continue");
        // No synthetic agent messages are sent during steering (only the user's
        // resubmitted text), and the second input is ignored (no active slot).
        assert.equal(sent.length, 0);
        assert.equal(abortCalls, 0);
        assert.deepEqual(resubmitted, [{ text: "first", deliverAs: "steer" }]);
    });

    void it("with no foreground command, Enter interrupts and resends the message once idle", async () => {
        const reg = new BackgroundRegistry();
        const sent: { customType?: string }[] = [];
        const resubmitted: ResubmittedMessage[] = [];
        let idle = false;
        const handler = registerAndGetHandler(reg, sent, resubmitted);

        const result = await handler(
            { type: "input", text: "change of plan", source: "interactive", streamingBehavior: "steer" },
            makeCtx([], { abort: () => { idle = true; }, isIdle: () => idle })
        );

        assert.deepEqual(result, { action: "handled" });
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.deepEqual(resubmitted, [{ text: "change of plan", deliverAs: undefined }]);
    });

    void it("keeps pi's queueing for Alt+Enter follow-ups with no foreground command", async () => {
        const reg = new BackgroundRegistry();
        const resubmitted: ResubmittedMessage[] = [];
        let abortCalled = false;
        const handler = registerAndGetHandler(reg, [], resubmitted);

        const result = await handler(
            { type: "input", text: "later", source: "interactive", streamingBehavior: "followUp" },
            makeCtx([], { abort: () => { abortCalled = true; } })
        );

        assert.deepEqual(result, { action: "continue" });
        assert.equal(abortCalled, false);
        assert.equal(resubmitted.length, 0);
    });

    void it("a '+' prefix steers gently: no backgrounding, no abort, prefix stripped", async () => {
        const reg = new BackgroundRegistry();
        let paused = false;
        let abortCalled = false;
        const handler = registerAndGetHandler(reg, [], []);
        reg.foreground.set("tc-gentle", { requestPause: () => { paused = true; } });

        const result = await handler(
            { type: "input", text: "+ also check the logs", source: "interactive", streamingBehavior: "steer" },
            makeCtx([], { abort: () => { abortCalled = true; } })
        );

        assert.deepEqual(result, { action: "transform", text: "also check the logs", images: undefined });
        assert.equal(paused, false);
        assert.equal(abortCalled, false);
    });

    void it("leaves slash commands alone", async () => {
        const reg = new BackgroundRegistry();
        let paused = false;
        const handler = registerAndGetHandler(reg, [], []);
        reg.foreground.set("tc-slash", { requestPause: () => { paused = true; } });

        const result = await handler(
            { type: "input", text: "/bg-list", source: "interactive", streamingBehavior: "steer" },
            makeCtx([], { abort: () => {} })
        );

        assert.deepEqual(result, { action: "continue" });
        assert.equal(paused, false);
    });

    void it("ignores extension-sourced input (recursion guard)", async () => {
        const reg = new BackgroundRegistry();
        const sent: { customType?: string }[] = [];
        const resubmitted: ResubmittedMessage[] = [];
        const handler = registerAndGetHandler(reg, sent, resubmitted);
        reg.foreground.set("tc-ext", {
            requestPause: () => {},
        });

        const result = await handler(
            { type: "input", text: "self-resubmit", source: "extension", streamingBehavior: "steer" },
            makeCtx([], { abort: () => {} })
        );

        assert.deepEqual(result, { action: "continue" });
        assert.equal(sent.length, 0);
        assert.equal(resubmitted.length, 0);
    });
});

function registerAndGetHandler(
    reg: BackgroundRegistry,
    sent: { customType?: string }[],
    resubmitted: ResubmittedMessage[]
): InputHandler {
    let handler: InputHandler | undefined;
    registerInputHandlers(
        {
            on(event: string, fn: InputHandler) {
                if (event === "input") handler = fn;
            },
            sendMessage(message: { customType?: string }) {
                sent.push(message);
            },
            sendUserMessage(content: string | object[], options?: { deliverAs?: string }) {
                if (typeof content === "string") {
                    resubmitted.push({ text: content, deliverAs: options?.deliverAs });
                }
            },
        } as never,
        reg
    );
    assert.ok(handler);
    return handler;
}

function makeCtx(
    notifications: string[] = [],
    actions?: { abort(): void; isIdle?(): boolean }
): UiContext & { abort(): void; isIdle(): boolean } {
    return {
        ui: {
            notify: (message) => notifications.push(message),
            setWidget: () => {},
            setStatus: () => {},
            theme: { fg: (_colour, text) => text },
            select: async () => undefined,
            editor: async () => undefined,
        },
        abort: actions?.abort ?? (() => {}),
        isIdle: actions?.isIdle ?? (() => true),
    };
}
