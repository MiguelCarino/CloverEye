// The reply keys (ui/js/keys-model.js): R, the menu keys, and why a thread
// takes no reply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReplyKey, isLayoutKey, keyLetter, isMenuKey, replyBlock, REPLY_BLOCKED } from '../ui/js/keys-model.js';

test('R and Shift+R are the reply key; with Ctrl, ⌘ or Alt they are not', () => {
  assert.equal(isReplyKey({ key: 'r' }), true);
  assert.equal(isReplyKey({ key: 'R', shiftKey: true }), true);
  assert.equal(isReplyKey({ key: 'r', ctrlKey: true }), false); // Update
  assert.equal(isReplyKey({ key: 'r', metaKey: true }), false); // Update on a Mac
  assert.equal(isReplyKey({ key: 'r', altKey: true }), false);
  assert.equal(isReplyKey({ key: 'u' }), false);
  assert.equal(isReplyKey(null), false);
});

test('R and L on other layouts: the letter typed, else the key’s place', () => {
  // Russian ЙЦУКЕН: R's place types к, L's types д
  assert.equal(isReplyKey({ key: 'к', code: 'KeyR' }), true);
  assert.equal(isReplyKey({ key: 'К', code: 'KeyR', shiftKey: true }), true);
  assert.equal(isLayoutKey({ key: 'д', code: 'KeyL' }), true);
  // a Latin layout's own letter wins (Dvorak: R sits at O's place)
  assert.equal(isReplyKey({ key: 'r', code: 'KeyO' }), true);
  assert.equal(isReplyKey({ key: 'p', code: 'KeyR' }), false);
  assert.equal(isLayoutKey({ key: 'n', code: 'KeyL' }), false);
  assert.equal(isLayoutKey({ key: 'L', shiftKey: true }), true);
  assert.equal(isLayoutKey({ key: 'l', ctrlKey: true }), false);
  // no letter at all: punctuation, named keys
  assert.equal(keyLetter({ key: ',', code: 'KeyW' }), '');
  assert.equal(keyLetter({ key: 'Enter', code: 'Enter' }), '');
  assert.equal(keyLetter({ key: 'ж', code: 'Semicolon' }), '');
});

test('the menu key and Shift+F10 open a menu; F10 alone or with Ctrl does not', () => {
  assert.equal(isMenuKey({ key: 'ContextMenu' }), true);
  assert.equal(isMenuKey({ key: 'F10', shiftKey: true }), true);
  assert.equal(isMenuKey({ key: 'F10' }), false);
  assert.equal(isMenuKey({ key: 'F10', shiftKey: true, ctrlKey: true }), false);
  assert.equal(isMenuKey({ key: 'ContextMenu', altKey: true }), false);
  assert.equal(isMenuKey({ key: 'Enter' }), false);
  assert.equal(isMenuKey(undefined), false);
});

test('a thread takes no reply when gone, archived or closed, and says which', () => {
  assert.equal(replyBlock(undefined), ''); // not loaded yet: Reply is offered, as its button is
  assert.equal(replyBlock({ status: 'loading' }), '');
  assert.equal(replyBlock({ posts: [{ no: 1 }] }), '');
  assert.equal(replyBlock({ gone: true, posts: [{ no: 1 }] }), 'gone');
  assert.equal(replyBlock({ posts: [{ no: 1, archived: 1, closed: 1 }] }), 'archived');
  assert.equal(replyBlock({ posts: [{ no: 1, closed: 1 }] }), 'closed');
  for (const k of ['gone', 'archived', 'closed']) assert.equal(typeof REPLY_BLOCKED[k], 'string');
});
