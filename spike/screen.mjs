// src/daemon/screen.ts, bundled as it is: the reader of the input box of Claude Code.
var SGR = /\u001b\[([0-9;]*)m/g;
var RULE = /^─{10,}(?: \S.* ─+)?$/;
var DRAWING = /^[─│┌┐└┘├┤┬┴┼╭╮╯╰\s]*$/;
var plain = (line) => line.replace(SGR, "").replace(/\s+$/, "");
function bright(line) {
  let dim = false;
  let out = "";
  let last = 0;
  for (const match of line.matchAll(SGR)) {
    if (!dim) out += line.slice(last, match.index);
    const codes = (match[1] ?? "").split(";");
    if (codes.includes("2")) dim = true;
    else if (match[1] === "" || codes.includes("0") || codes.includes("22")) dim = false;
    last = (match.index ?? 0) + match[0].length;
  }
  if (!dim) out += line.slice(last);
  return out;
}
function readPromptBox(capture) {
  const lines = capture.split("\n");
  const rules = [];
  lines.forEach((line, index) => {
    if (RULE.test(plain(line).trim())) rules.push(index);
  });
  if (rules.length < 2) return { found: false, typed: "" };
  const box = lines.slice(rules[rules.length - 2] + 1, rules[rules.length - 1]).filter((line) => !DRAWING.test(plain(line)));
  const first = box[0];
  if (first === void 0 || !plain(first).trimStart().startsWith("\u276F")) return { found: false, typed: "" };
  const typed = box.map((line, index) => {
    const text = bright(line);
    return index === 0 ? text.replace(/^\s*❯/, "") : text;
  }).join(" ").replace(/\s+/g, " ").trim();
  return { found: true, typed };
}
function keepsWorktree(capture) {
  const lines = capture.split("\n").map(plain);
  if (!lines.some((line) => line.trim() === "Exiting worktree session")) return false;
  const keep = lines.some((line) => /^\s*❯\s*1\.\s*Keep worktree\b/.test(line));
  const remove = lines.some((line) => /^\s*❯\s*\d+\.\s*Remove worktree\b/.test(line));
  return keep && !remove;
}
function screenShows(capture, text) {
  const flat = capture.split("\n").map(plain).join(" ").replace(/\s+/g, " ");
  return flat.includes(text.replace(/\s+/g, " ").trim());
}
export {
  keepsWorktree,
  readPromptBox,
  screenShows
};
