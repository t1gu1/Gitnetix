/** Emoji to react with, by group: the character, then its names (GitHub's and Slack's, which Linear stores, "+1"). */
// shortcut: a hand-picked set for reactions, not all of Unicode; add a full emoji dataset if people miss some.
export const EMOJI_GROUPS: [string, string[][]][] = [
  [
    "Smileys",
    [
      ["😀", "grinning"], ["😃", "smiley"], ["😄", "smile"], ["😁", "grin"], ["😆", "laughing", "satisfied"], ["😅", "sweat_smile"], ["🤣", "rofl", "rolling_on_the_floor_laughing"],
      ["😂", "joy"], ["🙂", "slightly_smiling_face"], ["🙃", "upside_down_face"], ["😉", "wink"], ["😊", "blush"], ["😇", "innocent"], ["🥰", "smiling_face_with_three_hearts"],
      ["😍", "heart_eyes"], ["🤩", "star_struck"], ["😘", "kissing_heart"], ["😋", "yum"], ["😛", "stuck_out_tongue"], ["🤪", "zany_face"], ["🤗", "hugs", "hugging_face"],
      ["🤭", "hand_over_mouth"], ["🤫", "shushing_face"], ["🤔", "thinking", "thinking_face"], ["🤨", "raised_eyebrow"], ["😐", "neutral_face"], ["😑", "expressionless"],
      ["😶", "no_mouth"], ["🙄", "roll_eyes", "face_with_rolling_eyes"], ["😏", "smirk"], ["😬", "grimacing"], ["😮", "open_mouth"], ["😯", "hushed"], ["😲", "astonished"],
      ["😳", "flushed"], ["🥺", "pleading_face"], ["😕", "confused"], ["😢", "cry"], ["😭", "sob"], ["😤", "triumph"], ["😠", "angry"], ["😡", "rage"], ["🤯", "exploding_head"],
      ["😱", "scream"], ["😴", "sleeping"], ["🤓", "nerd_face"], ["😎", "sunglasses"], ["🥳", "partying_face"], ["🫡", "saluting_face"], ["🫠", "melting_face"],
      ["🤦", "facepalm", "person_facepalming"], ["🤷", "shrug", "person_shrugging"], ["🙈", "see_no_evil"], ["💀", "skull"], ["👻", "ghost"], ["🤖", "robot", "robot_face"],
      ["🤡", "clown_face"], ["💩", "hankey", "poop", "shit"],
    ],
  ],
  [
    "Hands",
    [
      ["👍", "+1", "thumbsup"], ["👎", "-1", "thumbsdown"], ["👏", "clap"], ["🙌", "raised_hands"], ["🙏", "pray"], ["🤝", "handshake"], ["👋", "wave"], ["👌", "ok_hand"],
      ["✌️", "v"], ["🤞", "crossed_fingers"], ["🤘", "metal"], ["💪", "muscle"], ["👉", "point_right"], ["👆", "point_up_2"], ["✋", "hand", "raised_hand"], ["🫶", "heart_hands"],
      ["👀", "eyes"], ["🧠", "brain"],
    ],
  ],
  [
    "Symbols",
    [
      ["❤️", "heart"], ["🧡", "orange_heart"], ["💛", "yellow_heart"], ["💚", "green_heart"], ["💙", "blue_heart"], ["💜", "purple_heart"], ["🖤", "black_heart"],
      ["💔", "broken_heart"], ["💯", "100"], ["✅", "white_check_mark"], ["✔️", "heavy_check_mark"], ["❌", "x"], ["❓", "question"], ["❗", "exclamation", "heavy_exclamation_mark"],
      ["⚠️", "warning"], ["🚫", "no_entry_sign"], ["⭐", "star"], ["🌟", "star2"], ["✨", "sparkles"], ["🔥", "fire"], ["⚡", "zap"], ["💥", "boom", "collision"],
    ],
  ],
  [
    "Things",
    [
      ["🎉", "tada"], ["🎊", "confetti_ball"], ["🚀", "rocket"], ["🏆", "trophy"], ["🥇", "1st_place_medal"], ["🎯", "dart"], ["💡", "bulb"], ["📌", "pushpin"], ["📎", "paperclip"],
      ["🔗", "link"], ["🐛", "bug"], ["🛠️", "hammer_and_wrench"], ["🔧", "wrench"], ["⚙️", "gear"], ["🧪", "test_tube"], ["📦", "package"], ["🔒", "lock"], ["🔑", "key"],
      ["⏳", "hourglass_flowing_sand"], ["⏰", "alarm_clock"], ["📈", "chart_with_upwards_trend"], ["📉", "chart_with_downwards_trend"], ["📝", "memo", "pencil"], ["📣", "mega"],
      ["👑", "crown"], ["☕", "coffee"], ["🍕", "pizza"], ["🍺", "beer"], ["🎂", "birthday"], ["🌈", "rainbow"], ["☀️", "sunny"], ["🐢", "turtle"], ["🦄", "unicorn"], ["🐙", "octopus"],
    ],
  ],
];

/** The emoji people react with most, shown first. */
export const FREQUENT = ["👍", "🎉", "❤️", "👀", "🚀", "😄", "🙏", "✅"];

const byName = new Map<string, string>();
const nameOf = new Map<string, string>();
for (const [, list] of EMOJI_GROUPS)
  for (const [e, ...names] of list) {
    nameOf.set(e, names[0]);
    for (const n of names) byName.set(n, e);
  }

/** The character for a reaction a tracker names ("+1", ":tada:"), or `key` itself when it already is one; undefined for a
 *  name this list doesn't know, such as a workspace's own emoji. */
export function emojiOf(key: string): string | undefined {
  const k = key.replace(/^:|:$/g, "");
  return byName.get(k) ?? (nameOf.has(key) || !/^[\w+-]+$/.test(key) ? key : undefined);
}

/** The name an emoji goes by (":tada:"), for search and tooltips. */
export const emojiName = (e: string) => nameOf.get(e) ?? "";
