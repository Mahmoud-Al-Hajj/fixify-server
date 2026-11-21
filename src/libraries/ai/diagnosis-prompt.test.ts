import { test } from "node:test";
import assert from "node:assert/strict";
import { MESSAGE_SENDER } from "../../constants/message-sender";
import {
  buildContent,
  photosInContentOrder,
  type PromptPhoto,
} from "./diagnosis-prompt";

const photo = (messageId: number, data: string): PromptPhoto => ({
  messageId,
  mimeType: "image/jpeg",
  data,
});

test("each message's text comes before its own photos, in message order", () => {
  const content = buildContent(
    [
      { id: 1, sender: MESSAGE_SENDER.CUSTOMER, body: "water under the sink" },
      { id: 2, sender: MESSAGE_SENDER.CUSTOMER, body: "and the tap drips" },
    ],
    [photo(2, "C"), photo(1, "A"), photo(1, "B")]
  );
  assert.deepEqual(content, [
    { type: "text", text: "Customer message 1:\nwater under the sink" },
    { type: "image", data: "A", mime_type: "image/jpeg" },
    { type: "image", data: "B", mime_type: "image/jpeg" },
    { type: "text", text: "Customer message 2:\nand the tap drips" },
    { type: "image", data: "C", mime_type: "image/jpeg" },
  ]);
});

// A diagnosis's photoIndex N is read back as the Nth photo of this order.
test("photosInContentOrder is the order buildContent sends the images", () => {
  const messages = [
    { id: 1, sender: MESSAGE_SENDER.CUSTOMER, body: "water under the sink" },
    { id: 2, sender: MESSAGE_SENDER.AI, body: "A photo would help." },
    { id: 3, sender: MESSAGE_SENDER.CUSTOMER, body: null },
  ];
  const photos = [photo(3, "C"), photo(1, "A"), photo(9, "X"), photo(1, "B")];
  const sent = buildContent(messages, photos).flatMap((part) =>
    part.type === "image" ? [part.data] : []
  );
  assert.deepEqual(sent, ["A", "B", "C"]);
  assert.deepEqual(
    photosInContentOrder(messages, photos).map((p) => p.data),
    sent
  );
});

test("a message with no text is marked as photo only", () => {
  const content = buildContent(
    [
      { id: 1, sender: MESSAGE_SENDER.CUSTOMER, body: null },
      { id: 2, sender: MESSAGE_SENDER.CUSTOMER, body: "  " },
    ],
    [photo(1, "A"), photo(2, "B")]
  );
  assert.deepEqual(content, [
    { type: "text", text: "Customer message 1: (photo only)" },
    { type: "image", data: "A", mime_type: "image/jpeg" },
    { type: "text", text: "Customer message 2: (photo only)" },
    { type: "image", data: "B", mime_type: "image/jpeg" },
  ]);
});

test("earlier AI notes are included and not counted as customer messages", () => {
  const content = buildContent(
    [
      { id: 1, sender: MESSAGE_SENDER.CUSTOMER, body: "something leaks" },
      {
        id: 2,
        sender: MESSAGE_SENDER.AI,
        body: "A photo of the pipe joint would help.",
      },
      { id: 3, sender: MESSAGE_SENDER.CUSTOMER, body: "here is the joint" },
    ],
    [photo(3, "A")]
  );
  assert.deepEqual(content, [
    { type: "text", text: "Customer message 1:\nsomething leaks" },
    {
      type: "text",
      text: "Earlier assistant note (previous analysis):\nA photo of the pipe joint would help.",
    },
    { type: "text", text: "Customer message 2:\nhere is the joint" },
    { type: "image", data: "A", mime_type: "image/jpeg" },
  ]);
});
