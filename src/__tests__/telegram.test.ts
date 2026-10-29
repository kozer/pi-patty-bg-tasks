import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { telegramHandler, type TelegramUpdate } from "../telegram.ts";

const OWNER = 42;

void describe("telegram steering", () => {
    void it("backgrounds a running command and steers the text in", async () => {
        const t = setup({ busy: true, backgrounds: true });
        assert.equal(await t.handle(message("say banana")), "consume");
        assert.deepEqual(t.steered, ["say banana"]);
        assert.equal(t.aborts, 0);
        assert.deepEqual(t.reactions, [[OWNER, 7]]);
    });

    void it("with no command to background, interrupts and leaves the message to pi-telegram", async () => {
        const t = setup({ busy: true, backgrounds: false });
        assert.equal(await t.handle(message("say banana")), "pass");
        assert.equal(t.aborts, 1);
        assert.deepEqual(t.steered, []);
    });

    void it("a '+' prefix steers without backgrounding or aborting", async () => {
        const t = setup({ busy: true, backgrounds: true });
        assert.equal(await t.handle(message("+ also this")), "consume");
        assert.deepEqual(t.steered, ["also this"]);
        assert.equal(t.backgroundCalls, 0);
        assert.equal(t.aborts, 0);
    });

    void it("passes when pi is idle, for commands, and for anyone but the owner", async () => {
        const idle = setup({ busy: false, backgrounds: true });
        assert.equal(await idle.handle(message("hi")), "pass");
        const busy = setup({ busy: true, backgrounds: true });
        assert.equal(await busy.handle(message("/abort")), "pass");
        assert.equal(await busy.handle(message("hi", 99)), "pass");
        assert.equal(busy.aborts + busy.steered.length + idle.aborts, 0);
    });

    void it("a voice note or photo (no text) backgrounds the command, interrupts, and is left to pi-telegram", async () => {
        const t = setup({ busy: true, backgrounds: true });
        assert.equal(await t.handle(media()), "pass");
        assert.equal(t.backgroundCalls, 1);
        assert.equal(t.aborts, 1);
        assert.deepEqual(t.steered, []);
    });

    void it("a voice note or photo with no command to background interrupts", async () => {
        const t = setup({ busy: true, backgrounds: false });
        assert.equal(await t.handle(media()), "pass");
        assert.equal(t.aborts, 1);
    });

    void it("passes untouched while a dialog waits for an answer", async () => {
        const t = setup({ busy: true, backgrounds: true, prompting: true });
        assert.equal(await t.handle(message("yes")), "pass");
        assert.equal(await t.handle(media()), "pass");
        assert.equal(t.backgroundCalls + t.aborts + t.steered.length, 0);
    });

    void it("passes, so pi-telegram queues it, when the steer throws", async () => {
        const t = setup({ busy: true, backgrounds: true, steerThrows: true });
        assert.equal(await t.handle(message("say banana")), "pass");
        assert.deepEqual(t.reactions, []);
    });
});

function message(text: string, from = OWNER): TelegramUpdate {
    return { message: { message_id: 7, chat: { id: OWNER, type: "private" }, from: { id: from }, text } };
}

function media(): TelegramUpdate {
    const update = message("");
    delete update.message!.text;
    return update;
}

function setup(opts: { busy: boolean; backgrounds: boolean; steerThrows?: boolean; prompting?: boolean }) {
    const t = {
        aborts: 0,
        backgroundCalls: 0,
        steered: [] as string[],
        reactions: [] as [number, number][],
        handle: (update: TelegramUpdate) => Promise.resolve(handler(update)),
    };
    const ctx = { isIdle: () => !opts.busy, abort: () => { t.aborts++; } };
    const handler = telegramHandler({
        owner: OWNER,
        context: () => ctx as never,
        prompting: () => opts.prompting ?? false,
        background: () => {
            t.backgroundCalls++;
            return opts.backgrounds;
        },
        steer: (text) => {
            if (opts.steerThrows) throw new Error("session gone");
            t.steered.push(text);
        },
        react: (chatId, messageId) => { t.reactions.push([chatId, messageId]); },
    });
    return t;
}
