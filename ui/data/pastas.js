// Pre-written posts (the pastas popup, ui/js/pasta-view.js): short bump and
// reaction lines and well-known imageboard copypastas, as they are usually
// posted (>greentext lines kept). Content rules: friendly bumps only; no
// slurs, no hate or harassment, nothing sexual, no song lyrics or lines
// quoted from books, films, TV or games, nothing that reads as a threat.
//
// Each entry: id (a stable slug: pinned lists and settings keep it), title,
// text, tags (bump, reaction, classic, greentext, tech) and length
// ('short' up to 40 characters, 'medium' up to 300, 'long' past that;
// pasta-model.js lengthOf, checked by tests/pasta-model.test.mjs).
//
// What is in here is site content, not UI text: it is never translated
// (the popup marks it translate="no"), and it lives outside ui/js so the
// translation key list (tools/i18n-strings.mjs) never picks it up.

export default [
  { id: 'bump', title: 'Bump', text: 'bump', tags: ['bump'], length: 'short' },
  { id: 'bumping-for-interest', title: 'Bumping for interest', text: 'Bumping for interest.', tags: ['bump'], length: 'short' },
  { id: 'bump-quality', title: 'Bump for a quality thread', text: 'Bump for a quality thread.', tags: ['bump'], length: 'short' },
  { id: 'bump-night', title: 'Bump before bed', text: 'Going to bed. Bumping so this thread is still here in the morning.', tags: ['bump'], length: 'medium' },
  { id: 'bump-rolling', title: 'Rolling to bump', text: 'Rolling. Dubs and I bump this thread again.', tags: ['bump', 'classic'], length: 'medium' },
  { id: 'this', title: 'This', text: 'This.', tags: ['reaction'], length: 'short' },
  { id: 'checked', title: 'Checked', text: 'Checked.', tags: ['reaction'], length: 'short' },
  { id: 'based', title: 'Based', text: 'Based.', tags: ['reaction'], length: 'short' },
  { id: 'kek', title: 'Kek', text: 'kek', tags: ['reaction'], length: 'short' },
  { id: 'slash-thread', title: '/thread', text: '/thread', tags: ['reaction', 'classic'], length: 'short' },
  { id: 'sauce', title: 'Sauce?', text: 'Sauce?', tags: ['reaction'], length: 'short' },
  { id: 'source', title: 'Source?', text: 'Source?', tags: ['reaction'], length: 'short' },
  { id: 'more-please', title: 'More please', text: 'More, please.', tags: ['reaction', 'bump'], length: 'short' },
  { id: 'saved', title: 'Saved', text: 'Saved.', tags: ['reaction'], length: 'short' },
  { id: 'thank-you-anon', title: 'Thank you, anon', text: 'Thank you, anon.', tags: ['reaction'], length: 'short' },
  { id: 'good-thread', title: 'Good thread', text: 'Good thread.', tags: ['reaction', 'bump'], length: 'short' },
  { id: 'comfy-thread', title: 'Comfy thread', text: 'Comfy thread. Thank you, OP.', tags: ['reaction', 'bump'], length: 'short' },
  { id: 'op-delivers', title: 'OP delivers', text: 'OP delivers.', tags: ['reaction', 'classic'], length: 'short' },
  { id: 'fpbp', title: 'First post best post', text: 'fpbp', tags: ['reaction', 'classic'], length: 'short' },
  { id: 'inb4-404', title: 'inb4 404', text: 'inb4 404', tags: ['reaction', 'classic'], length: 'short' },
  { id: 'implying', title: '>implying', text: '>implying', tags: ['reaction', 'classic', 'greentext'], length: 'short' },
  { id: 'who-are-you-quoting', title: 'Who are you quoting?', text: 'Who are you quoting?', tags: ['reaction', 'classic'], length: 'short' },
  { id: 'thanks-for-the-you', title: 'Thanks for the (You)', text: 'Thanks for the (You).', tags: ['reaction', 'classic'], length: 'short' },
  { id: 'nice-try-fbi', title: 'Nice try, FBI', text: 'Nice try, FBI.', tags: ['reaction', 'classic'], length: 'short' },
  { id: 'im-12', title: "I'm 12 and what is this?", text: "I'm 12 and what is this?", tags: ['reaction', 'classic'], length: 'short' },
  { id: 'its-happening', title: "It's happening", text: "IT'S HAPPENING", tags: ['reaction', 'classic'], length: 'short' },
  { id: 'pics-or-it-didnt-happen', title: "Pics or it didn't happen", text: "Pics or it didn't happen.", tags: ['reaction', 'classic'], length: 'short' },
  { id: 'cool-story', title: 'Cool story, bro', text: 'Cool story, bro.', tags: ['reaction', 'classic'], length: 'short' },
  { id: 'hello-dog', title: 'Hello, yes, this is dog', text: 'Hello, yes, this is dog.', tags: ['reaction', 'classic'], length: 'short' },
  { id: 'return-to-monke', title: 'Return to monke', text: 'Return to monke.', tags: ['reaction', 'classic'], length: 'short' },
  { id: 'lurker', title: 'Long time lurker', text: 'Long time lurker, first time poster.', tags: ['classic'], length: 'short' },
  { id: 'doesnt-afraid', title: "Doesn't afraid of anything", text: 'halo is a cool guy, eh kills aleins and doesnt afraid of anything', tags: ['classic'], length: 'medium' },
  { id: 'r8-8-8', title: 'I r8 8/8', text: "i r8 8/8 m8. it's gr8, no h8. str8 up gr8 b8 m8, i appreci8 it. no need to deb8, it's gr8. 8/8.", tags: ['classic', 'reaction'], length: 'medium' },
  { id: 'mods-asleep', title: 'The mods are asleep', text: 'The mods are asleep.\nPost bread.', tags: ['classic'], length: 'short' },
  { id: 'cat-thread', title: 'This is now a cat thread', text: 'This thread is now a cat thread.\nPost cats.', tags: ['classic'], length: 'medium' },
  { id: 'be-me-bump', title: 'Be me, bump', text: '>be me\n>open the catalog\n>find this thread\n>it is actually good\n>bump', tags: ['greentext', 'bump'], length: 'medium' },
  { id: 'install-gentoo', title: 'Install Gentoo', text: 'Install Gentoo.', tags: ['classic', 'tech'], length: 'short' },
  { id: 'arch-btw', title: 'I use Arch, btw', text: 'I use Arch, btw.', tags: ['classic', 'tech'], length: 'short' },
  { id: 'linux-desktop', title: 'Year of the Linux desktop', text: 'This is the year of the Linux desktop.', tags: ['classic', 'tech'], length: 'short' },
  {
    id: 'gnu-interjection',
    title: "I'd just like to interject (GNU/Linux)",
    text: "I'd just like to interject for a moment. What you're referring to as Linux, is in fact, GNU/Linux, or as I've recently taken to calling it, GNU plus Linux. Linux is not an operating system unto itself, but rather another free component of a fully functioning GNU system made useful by the GNU corelibs, shell utilities and vital system components comprising a full OS as defined by POSIX.",
    tags: ['classic', 'tech'],
    length: 'long',
  },
];
