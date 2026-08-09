import { createInterface } from "node:readline/promises";
import { emitKeypressEvents, type Key } from "node:readline";
import { stdin, stdout } from "node:process";
import {
  MODEL_ROLES,
  type RoleStatus,
  type VexRunState,
} from "./types.js";

const colorEnabled = stdout.isTTY && !process.env.NO_COLOR;
const ansi = {
  reset: colorEnabled ? "\x1b[0m" : "",
  bold: colorEnabled ? "\x1b[1m" : "",
  dim: colorEnabled ? "\x1b[2m" : "",
  cyan: colorEnabled ? "\x1b[36m" : "",
  green: colorEnabled ? "\x1b[32m" : "",
  yellow: colorEnabled ? "\x1b[33m" : "",
  red: colorEnabled ? "\x1b[31m" : "",
  blue: colorEnabled ? "\x1b[34m" : "",
  magenta: colorEnabled ? "\x1b[35m" : "",
  inverse: colorEnabled ? "\x1b[7m" : "",
};

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function crop(value: string, width: number): string {
  const plain = stripAnsi(value);
  if (plain.length <= width) return value;
  return `${plain.slice(0, Math.max(0, width - 1))}…`;
}

function pad(value: string, width: number): string {
  const cropped = crop(value, width);
  return `${cropped}${" ".repeat(Math.max(0, width - stripAnsi(cropped).length))}`;
}

function line(label: string, value: string, width: number): string {
  const prefix = ` ${ansi.dim}${label.padEnd(11)}${ansi.reset}`;
  return `│${pad(`${prefix}${value}`, width)}│`;
}

function statusStyle(status: RoleStatus): { icon: string; color: string } {
  if (status === "completed") return { icon: "●", color: ansi.green };
  if (status === "running") return { icon: "◆", color: ansi.cyan };
  if (status === "skipped") return { icon: "−", color: ansi.dim };
  if (status === "failed" || status === "blocked" || status === "aborted") {
    return { icon: "×", color: ansi.red };
  }
  return { icon: "○", color: ansi.dim };
}

function roleCard(state: VexRunState, width: number): string[] {
  const cells = MODEL_ROLES.map((role) => {
    const current = state.roles[role];
    const style = statusStyle(current.status);
    return `${style.color}${style.icon}${ansi.reset} ${role}`;
  });
  const rows: string[] = [];
  const columnWidth = Math.max(20, Math.floor(width / 2));
  for (let index = 0; index < cells.length; index += 2) {
    rows.push(
      `│${pad(` ${cells[index] ?? ""}`, columnWidth)}${pad(` ${cells[index + 1] ?? ""}`, width - columnWidth)}│`,
    );
  }
  return rows;
}

function frame(title: string, rows: string[], requestedWidth?: number): string {
  const width = Math.max(
    58,
    Math.min(requestedWidth ?? stdout.columns ?? 92, 112) - 2,
  );
  const heading = ` ${ansi.bold}${ansi.cyan}VEX${ansi.reset} ${ansi.dim}•${ansi.reset} ${title} `;
  const top = `┌${heading}${"─".repeat(Math.max(0, width - stripAnsi(heading).length))}┐`;
  return [top, ...rows, `└${"─".repeat(width)}┘`].join("\n");
}

export interface HomeView {
  root: string;
  kind: "git" | "directory";
  branch: string;
  head: string;
  dirty: boolean;
  latest?: VexRunState;
}

export function renderHome(view: HomeView): string {
  const width = Math.max(58, Math.min(stdout.columns ?? 92, 112) - 2);
  const latest = view.latest
    ? `${view.latest.status} · ${view.latest.id}`
    : "no runs yet";
  return frame(
    "adaptive agent session",
    [
      line(view.kind === "git" ? "repository" : "workspace", view.root, width),
      line(
        view.kind === "git" ? "branch" : "versioning",
        view.kind === "git"
          ? `${view.branch}@${view.head ? view.head.slice(0, 10) : "no-commit"}${view.dirty ? ` ${ansi.yellow}modified${ansi.reset}` : " clean"}`
          : `${ansi.green}managed snapshot isolation${ansi.reset} - no repository required`,
        width,
      ),
      line("latest", latest, width),
      `├${"─".repeat(width)}┤`,
      `│${pad(` ${ansi.bold}PROMPT${ansi.reset}`, width)}│`,
      `│${pad("  Type naturally; auto selects chat, review, or implement.", width)}│`,
      `│${pad("  Type / for live hints; use Up/Down and Tab to complete.", width)}│`,
      `│${pad("  /mode auto|chat|review|implement", width)}│`,
      `│${pad("  /provider · /model (two-pane model selector)", width)}│`,
      `│${pad("  /route (per-role routing) · /help · /quit", width)}│`,
      `├${"─".repeat(width)}┤`,
      `│${pad(` ${ansi.dim}Native VEX runtime • fixed roles • isolated worktrees${ansi.reset}`, width)}│`,
    ],
    width + 2,
  );
}

export function renderDashboard(state: VexRunState): string {
  const width = Math.max(58, Math.min(stdout.columns ?? 92, 112) - 2);
  const latestEvent = state.events.at(-1)?.message ?? "waiting";
  const integration = state.integrationRef?.slice(0, 10) ?? "not created";
  const rows = [
    line("run", state.id, width),
    line("goal", state.task, width),
    line("state", `${state.status} / ${state.phase}`, width),
    line("base", `${state.baseBranch}@${state.baseRef.slice(0, 10)}`, width),
    line("integration", integration, width),
    line("provider", state.provider.baseUrl, width),
    `├${"─".repeat(width)}┤`,
    `│${pad(` ${ansi.bold}TEAM${ansi.reset}`, width)}│`,
    ...roleCard(state, width),
    `├${"─".repeat(width)}┤`,
    line("activity", latestEvent, width),
    line("changes", `${state.changes.length} result(s), ${state.integratedCommits.length} commit(s)`, width),
    line("review", state.findings.length ? `${state.findings.length} finding(s)` : state.reviewsApproved ? "approved" : "pending", width),
  ];
  if (state.status === "awaiting-merge") {
    rows.push(
      `├${"─".repeat(width)}┤`,
      `│${pad(` ${ansi.green}${ansi.bold}READY${ansi.reset}  Inspect with vex diff; merge with vex merge.`, width)}│`,
    );
  }
  if (state.error) {
    rows.push(
      `├${"─".repeat(width)}┤`,
      `│${pad(` ${ansi.red}ERROR${ansi.reset} ${state.error}`, width)}│`,
    );
  }
  return frame("team dashboard", rows, width + 2);
}

export function clearAndRender(content: string): void {
  if (stdout.isTTY) stdout.write("\x1b[2J\x1b[H");
  stdout.write(`${content}\n`);
}

export type LineCompleter = (line: string) => [string[], string];

export interface LineHint {
  value: string;
  description?: string;
}

export type LineHintProvider = (line: string) => readonly LineHint[];

function glyphWidth(glyph: string): number {
  const codePoint = glyph.codePointAt(0) ?? 0;
  if (/\p{Mark}/u.test(glyph)) return 0;
  return codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
    ? 2
    : 1;
}

function displayWidth(value: string): number {
  return Array.from(stripAnsi(value)).reduce(
    (width, glyph) => width + glyphWidth(glyph),
    0,
  );
}

function lineViewport(
  glyphs: readonly string[],
  cursor: number,
  maximumWidth: number,
): { text: string; cursorColumn: number } {
  const width = Math.max(4, maximumWidth);
  const boundedCursor = Math.max(0, Math.min(cursor, glyphs.length));
  const rangeWidth = (start: number, end: number) =>
    glyphs.slice(start, end).reduce(
      (total, glyph) => total + glyphWidth(glyph),
      0,
    );
  let start = 0;
  while (start < boundedCursor) {
    const prefixWidth = start > 0 ? 1 : 0;
    if (prefixWidth + rangeWidth(start, boundedCursor) <= width - 1) break;
    start += 1;
  }

  const prefix = start > 0 ? "…" : "";
  let end = start;
  let visibleWidth = displayWidth(prefix);
  while (
    end < glyphs.length &&
    visibleWidth + glyphWidth(glyphs[end]!) <= width
  ) {
    visibleWidth += glyphWidth(glyphs[end]!);
    end += 1;
  }
  let suffix = "";
  if (end < glyphs.length) {
    suffix = "…";
    while (
      end > Math.max(start, boundedCursor) &&
      visibleWidth + displayWidth(suffix) > width
    ) {
      end -= 1;
      visibleWidth -= glyphWidth(glyphs[end]!);
    }
  }
  return {
    text: `${prefix}${glyphs.slice(start, end).join("")}${suffix}`,
    cursorColumn: displayWidth(prefix) + rangeWidth(start, boundedCursor),
  };
}

function hintRows(
  lineValue: string,
  hints: readonly LineHint[],
  activeHint: number,
): string[] {
  const rowWidth = Math.max(10, (stdout.columns ?? 80) - 1);
  const fit = (rows: string[]) => rows.map((row) => crop(row, rowWidth));
  if (!lineValue) {
    return fit([
      `${ansi.dim}  Hint: type / to view commands · Tab completes parameters${ansi.reset}`,
    ]);
  }
  if (!lineValue.trimStart().startsWith("/")) return [];
  if (hints.length === 0) {
    return fit(/\s/.test(lineValue.trimStart())
      ? [
          `${ansi.dim}  No known parameter suggestions · keep typing or press Enter${ansi.reset}`,
        ]
      : [
          `${ansi.yellow}  No matching command${ansi.reset}  ${ansi.dim}Use /help to list commands${ansi.reset}`,
        ]);
  }

  const maxVisible = Math.max(
    3,
    Math.min(8, Math.max(3, (stdout.rows ?? 24) - 5)),
  );
  const start = visibleStart(activeHint, hints.length, maxVisible);
  const lines = hints.slice(start, start + maxVisible).map((hint, offset) => {
    const index = start + offset;
    const marker = index === activeHint ? `${ansi.cyan}›${ansi.reset}` : " ";
    const value = `${ansi.cyan}${hint.value.trimEnd()}${ansi.reset}`;
    const detail = hint.description
      ? `  ${ansi.dim}${hint.description}${ansi.reset}`
      : "";
    return crop(
      `  ${marker} ${value}${detail}`,
      rowWidth,
    );
  });
  lines.push(
    `${ansi.dim}  ${hints.length} suggestion${hints.length === 1 ? "" : "s"} · ↑/↓ choose · Tab complete · Enter run${ansi.reset}`,
  );
  return fit(lines);
}

async function readHintedLine(
  prompt: string,
  hintProvider: LineHintProvider,
): Promise<string> {
  const wasRaw = stdin.isRaw;
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();

  return await new Promise<string>((resolve) => {
    let glyphs: string[] = [];
    let cursor = 0;
    let activeHint = 0;
    let closed = false;
    let renderScheduled = false;

    const value = () => glyphs.join("");
    const hints = () => hintProvider(value());
    const render = () => {
      if (closed) return;
      const currentHints = hints();
      activeHint = Math.max(
        0,
        Math.min(activeHint, Math.max(0, currentHints.length - 1)),
      );
      const rows = hintRows(value(), currentHints, activeHint);
      const promptWidth = displayWidth(prompt);
      const viewport = lineViewport(
        glyphs,
        cursor,
        Math.max(4, (stdout.columns ?? 80) - promptWidth - 1),
      );
      stdout.write(`\x1b[?25l\r\x1b[0J${prompt}${viewport.text}`);
      if (rows.length > 0) {
        stdout.write(`\r\n${rows.join("\r\n")}\x1b[${rows.length}F`);
      } else {
        stdout.write("\r");
      }
      stdout.write(
        `\x1b[${promptWidth + viewport.cursorColumn + 1}G\x1b[?25h`,
      );
    };
    const scheduleRender = () => {
      if (renderScheduled || closed) return;
      renderScheduled = true;
      queueMicrotask(() => {
        renderScheduled = false;
        render();
      });
    };
    const cleanup = () => {
      stdin.off("keypress", onKeypress);
      stdout.off("resize", scheduleRender);
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      stdout.write("\x1b[?25h");
    };
    const finish = (submitted: string, interrupted = false) => {
      if (closed) return;
      closed = true;
      stdout.write(
        `\x1b[?25l\r\x1b[0J${prompt}${submitted}${interrupted ? "^C" : ""}\r\n`,
      );
      cleanup();
      resolve(interrupted ? "/quit" : submitted.trim());
    };
    const resetSelection = () => {
      activeHint = 0;
    };
    const insert = (characters: readonly string[]) => {
      glyphs.splice(cursor, 0, ...characters);
      cursor += characters.length;
      resetSelection();
    };
    const onKeypress = (character: string | undefined, key: Key) => {
      if (closed) return;
      if (key.ctrl && key.name === "c") {
        finish(value(), true);
        return;
      }
      if (key.ctrl && key.name === "d" && glyphs.length === 0) {
        finish("", true);
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        finish(value());
        return;
      }
      const currentHints = hints();
      if (key.name === "up" && currentHints.length > 0) {
        activeHint = (activeHint - 1 + currentHints.length) % currentHints.length;
      } else if (key.name === "down" && currentHints.length > 0) {
        activeHint = (activeHint + 1) % currentHints.length;
      } else if (key.name === "pageup" && currentHints.length > 0) {
        activeHint = Math.max(0, activeHint - 8);
      } else if (key.name === "pagedown" && currentHints.length > 0) {
        activeHint = Math.min(currentHints.length - 1, activeHint + 8);
      } else if (key.name === "tab") {
        if (currentHints.length > 0) {
          const direction = key.shift ? -1 : 1;
          if (key.shift) {
            activeHint = (activeHint + direction + currentHints.length) %
              currentHints.length;
          } else {
            glyphs = Array.from(currentHints[activeHint]?.value ?? value());
            cursor = glyphs.length;
            resetSelection();
          }
        }
      } else if (key.name === "left" || (key.ctrl && key.name === "b")) {
        cursor = Math.max(0, cursor - 1);
      } else if (key.name === "right" || (key.ctrl && key.name === "f")) {
        cursor = Math.min(glyphs.length, cursor + 1);
      } else if (key.name === "home" || (key.ctrl && key.name === "a")) {
        cursor = 0;
      } else if (key.name === "end" || (key.ctrl && key.name === "e")) {
        cursor = glyphs.length;
      } else if (key.name === "backspace") {
        if (cursor > 0) glyphs.splice(--cursor, 1);
        resetSelection();
      } else if (key.name === "delete") {
        if (cursor < glyphs.length) glyphs.splice(cursor, 1);
        resetSelection();
      } else if (key.ctrl && key.name === "u") {
        glyphs.splice(0, cursor);
        cursor = 0;
        resetSelection();
      } else if (key.ctrl && key.name === "k") {
        glyphs.splice(cursor);
        resetSelection();
      } else if (key.ctrl && key.name === "w") {
        while (cursor > 0 && /\s/.test(glyphs[cursor - 1]!)) {
          glyphs.splice(--cursor, 1);
        }
        while (cursor > 0 && !/\s/.test(glyphs[cursor - 1]!)) {
          glyphs.splice(--cursor, 1);
        }
        resetSelection();
      } else if (
        character &&
        !key.ctrl &&
        !key.meta
      ) {
        insert(
          Array.from(character).filter(
            (glyph) => !/^[\u0000-\u001f\u007f]$/.test(glyph),
          ),
        );
      } else {
        return;
      }
      scheduleRender();
    };

    stdin.on("keypress", onKeypress);
    stdout.on("resize", scheduleRender);
    render();
  });
}

async function readLine(
  prompt: string,
  completer?: LineCompleter,
  hintProvider?: LineHintProvider,
): Promise<string> {
  if (
    hintProvider &&
    stdin.isTTY &&
    stdout.isTTY &&
    typeof stdin.setRawMode === "function"
  ) {
    return readHintedLine(prompt, hintProvider);
  }
  const readline = createInterface({
    input: stdin,
    output: stdout,
    ...(completer ? { completer } : {}),
  });
  try {
    return (await readline.question(prompt)).trim();
  } finally {
    readline.close();
  }
}

export interface SelectItem<T> {
  value: T;
  label: string;
  description?: string;
  keywords?: readonly string[];
}

export interface SelectOptions<T> {
  initialValue?: T;
  initialQuery?: string;
  maxVisible?: number;
  emptyMessage?: string;
}

function selectScore<T>(item: SelectItem<T>, terms: string[]): number | undefined {
  const label = item.label.toLowerCase();
  const primary = [item.label, ...(item.keywords ?? [])]
    .join(" ")
    .toLowerCase();
  const words = primary.split(/[^a-z0-9._:/-]+/i);
  const description = item.description?.toLowerCase() ?? "";
  let score = 0;
  for (const term of terms) {
    if (label.startsWith(term)) continue;
    if (words.some((word) => word.startsWith(term))) {
      score += 1;
      continue;
    }
    if (primary.includes(term)) {
      score += 2;
      continue;
    }
    if (description.includes(term)) {
      score += 4;
      continue;
    }
    return undefined;
  }
  return score;
}

export function filterSelectItems<T>(
  items: readonly SelectItem<T>[],
  query: string,
): SelectItem<T>[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...items];
  return items
    .map((item, index) => ({ item, index, score: selectScore(item, terms) }))
    .filter(
      (entry): entry is { item: SelectItem<T>; index: number; score: number } =>
        entry.score !== undefined,
    )
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => entry.item);
}

async function selectFromNumberedList<T>(
  title: string,
  items: readonly SelectItem<T>[],
): Promise<T | undefined> {
  stdout.write(`${title}\n`);
  items.forEach((item, index) => {
    stdout.write(
      `  ${index + 1}. ${item.label}${item.description ? ` - ${item.description}` : ""}\n`,
    );
  });
  const answer = await readLine("Select a number (blank to cancel): ");
  if (!answer) return undefined;
  const index = Number(answer) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= items.length) {
    throw new Error(`Invalid selection: ${answer}`);
  }
  return items[index]!.value;
}

export async function selectItem<T>(
  title: string,
  items: readonly SelectItem<T>[],
  options: SelectOptions<T> = {},
): Promise<T | undefined> {
  if (items.length === 0) return undefined;
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    return selectFromNumberedList(title, items);
  }

  const wasPaused = stdin.isPaused();
  emitKeypressEvents(stdin);
  const wasRaw = stdin.isRaw;
  const terminalWidth = Math.max(48, stdout.columns ?? 80);
  const maxVisible = Math.max(
    3,
    Math.min(options.maxVisible ?? 10, Math.max(3, (stdout.rows ?? 24) - 5)),
  );

  return new Promise<T | undefined>((resolve) => {
    let query = options.initialQuery?.trim() ?? "";
    let active = Math.max(
      0,
      items.findIndex((item) => Object.is(item.value, options.initialValue)),
    );
    let renderedLines = 0;
    let finished = false;

    const filtered = () => filterSelectItems(items, query);
    const erase = () => {
      if (renderedLines > 0) {
        stdout.write(`\x1b[${renderedLines}F\x1b[0J`);
        renderedLines = 0;
      }
    };
    const render = () => {
      erase();
      const matches = filtered();
      active = Math.max(0, Math.min(active, Math.max(0, matches.length - 1)));
      const start = Math.max(
        0,
        Math.min(active - Math.floor(maxVisible / 2), matches.length - maxVisible),
      );
      const visible = matches.slice(start, start + maxVisible);
      const lines = [
        `${ansi.bold}${ansi.cyan}${title}${ansi.reset}`,
        `${ansi.dim}Search:${ansi.reset} ${query || `${ansi.dim}type to filter${ansi.reset}`}  ${ansi.dim}${matches.length}/${items.length}${ansi.reset}`,
      ];
      if (visible.length === 0) {
        lines.push(`  ${ansi.yellow}${options.emptyMessage ?? "No matches"}${ansi.reset}`);
      } else {
        for (const [offset, item] of visible.entries()) {
          const index = start + offset;
          const detail = item.description ? `  ${ansi.dim}${item.description}${ansi.reset}` : "";
          const content = crop(`${item.label}${detail}`, terminalWidth - 5);
          lines.push(
            index === active
              ? `${ansi.inverse}> ${content}${ansi.reset}`
              : `  ${content}`,
          );
        }
      }
      lines.push(
        `${ansi.dim}↑/↓ move · type to search · Enter select · Esc cancel${ansi.reset}`,
      );
      stdout.write(`${lines.join("\n")}\n`);
      renderedLines = lines.length;
    };
    const finish = (value?: T) => {
      if (finished) return;
      finished = true;
      stdin.off("keypress", onKeypress);
      stdin.setRawMode(Boolean(wasRaw));
      if (wasPaused) stdin.pause();
      erase();
      stdout.write("\x1b[?25h");
      resolve(value);
    };
    const onKeypress = (character: string | undefined, key: Key) => {
      const matches = filtered();
      if ((key.ctrl && key.name === "c") || key.name === "escape") {
        finish();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        if (matches[active]) finish(matches[active]!.value);
        return;
      }
      if (key.name === "up") {
        active = matches.length > 0
          ? (active - 1 + matches.length) % matches.length
          : 0;
      } else if (key.name === "down" || key.name === "tab") {
        active = matches.length > 0 ? (active + 1) % matches.length : 0;
      } else if (key.name === "pageup") {
        active = Math.max(0, active - maxVisible);
      } else if (key.name === "pagedown") {
        active = Math.min(Math.max(0, matches.length - 1), active + maxVisible);
      } else if (key.name === "home") {
        active = 0;
      } else if (key.name === "end") {
        active = Math.max(0, matches.length - 1);
      } else if (key.name === "backspace") {
        query = Array.from(query).slice(0, -1).join("");
        active = 0;
      } else if (key.ctrl && key.name === "u") {
        query = "";
        active = 0;
      } else if (
        character &&
        !key.ctrl &&
        !key.meta &&
        !/^[\u0000-\u001f\u007f]$/.test(character)
      ) {
        query += character;
        active = 0;
      } else {
        return;
      }
      render();
    };

    stdout.write("\x1b[?25l");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", onKeypress);
    render();
  });
}

export interface ProviderModelPane<T> {
  id: string;
  label: string;
  description?: string;
  models: readonly SelectItem<T>[];
}

export interface ProviderModelSelectOptions<T> {
  initialProvider?: string;
  initialValue?: T;
  initialQuery?: string;
  maxVisible?: number;
  emptyMessage?: string;
}

export interface FollowupSelectOptions<T> {
  title: string;
  items: readonly SelectItem<T>[];
  initialValue?: T;
  emptyMessage?: string;
}

export interface ProviderModelTargetSelection<T, U> {
  model: T;
  target: U;
}

export interface ProviderModelTargetBehavior<T, U> {
  continueAfterAssign?: boolean;
  onAssign?(selection: ProviderModelTargetSelection<T, U>): string | void;
}

export interface SgrMouseEvent {
  button: number;
  column: number;
  row: number;
  release: boolean;
}

export function parseSgrMouseEvents(value: string): SgrMouseEvent[] {
  return [...value.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)].map(
    (match) => ({
      button: Number(match[1]),
      column: Number(match[2]),
      row: Number(match[3]),
      release: match[4] === "m",
    }),
  );
}

function visibleStart(active: number, count: number, size: number): number {
  return Math.max(
    0,
    Math.min(active - Math.floor(size / 2), Math.max(0, count - size)),
  );
}

async function selectProviderModelFlow<T, U>(
  title: string,
  providers: readonly ProviderModelPane<T>[],
  options: ProviderModelSelectOptions<T> = {},
  followup?: FollowupSelectOptions<U>,
  targetBehavior?: ProviderModelTargetBehavior<T, U>,
): Promise<T | ProviderModelTargetSelection<T, U> | undefined> {
  if (providers.length === 0) return undefined;
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    while (true) {
      const model = await selectFromNumberedList(
        title,
        providers.flatMap((provider) =>
          provider.models.map((model): SelectItem<T> => ({
            ...model,
            label: `${provider.label} / ${model.label}`,
            description: [model.description, provider.description]
              .filter(Boolean)
              .join(" · "),
          }))
        ),
      );
      if (model === undefined || !followup) return model;
      const target = await selectFromNumberedList(followup.title, followup.items);
      if (target === undefined) {
        if (targetBehavior?.continueAfterAssign) continue;
        return undefined;
      }
      const selection = { model, target };
      targetBehavior?.onAssign?.(selection);
      if (!targetBehavior?.continueAfterAssign) return selection;
    }
  }

  const wasPaused = stdin.isPaused();
  emitKeypressEvents(stdin);
  const wasRaw = stdin.isRaw;
  const terminalWidth = Math.max(48, stdout.columns ?? 96);
  const contentWidth = terminalWidth - 2;
  const providerWidth = Math.max(16, Math.min(30, Math.floor(contentWidth * 0.32)));
  const modelWidth = Math.max(20, contentWidth - providerWidth - 1);
  const maxVisible = Math.max(
    4,
    Math.min(options.maxVisible ?? 14, Math.max(4, (stdout.rows ?? 24) - 7)),
  );
  const firstItemRow = 6;

  return new Promise<T | ProviderModelTargetSelection<T, U> | undefined>((resolve) => {
    let providerIndex = Math.max(
      0,
      providers.findIndex((provider) => provider.id === options.initialProvider),
    );
    let modelIndex = 0;
    let query = options.initialQuery?.trim() ?? "";
    let pane: "providers" | "models" = "models";
    let finished = false;
    let providerStart = 0;
    let modelStart = 0;
    let targetStart = 0;
    let mouseKeyBuffer = "";
    let step: "models" | "followup" = "models";
    let chosenModel: SelectItem<T> | undefined;
    let chosenProviderLabel = "";
    let lastAssignment = "";
    const assignedTargets = new Set<U>();
    let targetIndex = Math.max(
      0,
      followup?.items.findIndex((item) =>
        Object.is(item.value, followup.initialValue)
      ) ?? 0,
    );

    const models = () => filterSelectItems(
      providers[providerIndex]?.models ?? [],
      query,
    );
    const applyInitialModel = () => {
      if (options.initialValue === undefined) return;
      const index = models().findIndex((item) =>
        Object.is(item.value, options.initialValue)
      );
      if (index >= 0) modelIndex = index;
    };
    applyInitialModel();

    const cell = (value: string, width: number, active: boolean) => {
      const content = crop(value, width);
      return pad(
        active ? `${ansi.inverse}${content}${ansi.reset}` : content,
        width,
      );
    };
    const render = () => {
      if (step === "followup" && followup && chosenModel) {
        targetIndex = Math.max(
          0,
          Math.min(targetIndex, Math.max(0, followup.items.length - 1)),
        );
        targetStart = visibleStart(
          targetIndex,
          followup.items.length,
          maxVisible,
        );
        const lines = [
          `${ansi.bold}${ansi.cyan}${crop(followup.title, terminalWidth)}${ansi.reset}`,
          crop(
            `${ansi.dim}Selected model:${ansi.reset} ${chosenProviderLabel} / ${chosenModel.label}`,
            terminalWidth,
          ),
          `┌${"─".repeat(contentWidth)}┐`,
          `│${pad(` ${ansi.bold}TARGET ROLE${ansi.reset}`, contentWidth)}│`,
          `├${"─".repeat(contentWidth)}┤`,
        ];
        for (let offset = 0; offset < maxVisible; offset++) {
          const index = targetStart + offset;
          const item = followup.items[index];
          const targetText = item
            ? `${index === targetIndex ? ">" : " "} ${assignedTargets.has(item.value) ? "✓ " : ""}${item.label}${item.description ? ` · ${item.description}` : ""}`
            : offset === 0 && followup.items.length === 0
              ? `  ${followup.emptyMessage ?? "No target roles"}`
              : "";
          lines.push(
            `│${cell(targetText, contentWidth, index === targetIndex && Boolean(item))}│`,
          );
        }
        lines.push(
          `└${"─".repeat(contentWidth)}┘`,
          crop(
            `${ansi.dim}↑/↓ move · Enter assign${targetBehavior?.continueAfterAssign ? " and continue" : ""} · Esc back · mouse enabled${ansi.reset}`,
            terminalWidth,
          ),
        );
        stdout.write(`\x1b[H\x1b[2J${lines.join("\n")}`);
        return;
      }
      providerIndex = Math.max(0, Math.min(providerIndex, providers.length - 1));
      const selectedProvider = providers[providerIndex]!;
      const matchingModels = models();
      modelIndex = Math.max(
        0,
        Math.min(modelIndex, Math.max(0, matchingModels.length - 1)),
      );
      providerStart = visibleStart(providerIndex, providers.length, maxVisible);
      modelStart = visibleStart(modelIndex, matchingModels.length, maxVisible);
      const lines = [
        `${ansi.bold}${ansi.cyan}${crop(title, terminalWidth)}${ansi.reset}`,
        crop(
          `${ansi.dim}Search models:${ansi.reset} ${query || `${ansi.dim}type to filter${ansi.reset}`}  ${ansi.dim}${selectedProvider.description ?? ""}${ansi.reset}`,
          terminalWidth,
        ),
        `┌${"─".repeat(providerWidth)}┬${"─".repeat(modelWidth)}┐`,
        `│${pad(` ${ansi.bold}PROVIDERS${ansi.reset}`, providerWidth)}│${pad(` ${ansi.bold}MODELS · ${selectedProvider.label}${ansi.reset}`, modelWidth)}│`,
        `├${"─".repeat(providerWidth)}┼${"─".repeat(modelWidth)}┤`,
      ];
      for (let offset = 0; offset < maxVisible; offset++) {
        const currentProviderIndex = providerStart + offset;
        const provider = providers[currentProviderIndex];
        const currentModelIndex = modelStart + offset;
        const model = matchingModels[currentModelIndex];
        const providerText = provider
          ? `${currentProviderIndex === providerIndex ? ">" : " "} ${provider.label} (${provider.models.length})`
          : "";
        const modelText = model
          ? `${currentModelIndex === modelIndex ? ">" : " "} ${model.label}${model.description ? ` · ${model.description}` : ""}`
          : offset === 0 && matchingModels.length === 0
            ? `  ${options.emptyMessage ?? "No models for this Provider"}`
            : "";
        lines.push(
          `│${cell(
            providerText,
            providerWidth,
            currentProviderIndex === providerIndex && pane === "providers",
          )}│${cell(
            modelText,
            modelWidth,
            currentModelIndex === modelIndex &&
              Boolean(model) &&
              pane === "models",
          )}│`,
        );
      }
      lines.push(`└${"─".repeat(providerWidth)}┴${"─".repeat(modelWidth)}┘`);
      if (lastAssignment) {
        lines.push(
          crop(
            `${ansi.green}✓ ${lastAssignment}${ansi.reset} · choose another model or press Esc to finish`,
            terminalWidth,
          ),
        );
      }
      lines.push(
        crop(
          `${ansi.dim}←/→ pane · ↑/↓ move · type search · Enter select · Esc ${targetBehavior?.continueAfterAssign ? "done" : "cancel"} · mouse enabled${ansi.reset}`,
          terminalWidth,
        ),
      );
      stdout.write(`\x1b[H\x1b[2J${lines.join("\n")}`);
    };
    const finish = (value?: T | ProviderModelTargetSelection<T, U>) => {
      if (finished) return;
      finished = true;
      stdin.off("keypress", onKeypress);
      stdin.setRawMode(Boolean(wasRaw));
      stdout.write("\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[2J\x1b[H");
      resolve(value);
      if (wasPaused) {
        setImmediate(() => {
          if (
            stdin.listenerCount("data") === 0 &&
            stdin.listenerCount("keypress") === 0
          ) {
            stdin.pause();
          }
        });
      }
    };
    const acceptModel = (item: SelectItem<T>) => {
      if (!followup) {
        finish(item.value);
        return;
      }
      chosenModel = item;
      chosenProviderLabel = providers[providerIndex]!.label;
      step = "followup";
    };
    const acceptTarget = () => {
      const target = followup?.items[targetIndex];
      if (chosenModel && target) {
        const selection = { model: chosenModel.value, target: target.value };
        const selectedModelLabel = `${chosenProviderLabel} / ${chosenModel.label}`;
        const notice = targetBehavior?.onAssign?.(selection);
        if (!targetBehavior?.continueAfterAssign) {
          finish(selection);
          return;
        }
        assignedTargets.add(target.value);
        lastAssignment = typeof notice === "string" && notice
          ? notice
          : `${target.label} ← ${selectedModelLabel}`;
        targetIndex = followup && followup.items.length > 0
          ? (targetIndex + 1) % followup.items.length
          : 0;
        chosenModel = undefined;
        chosenProviderLabel = "";
        pane = "models";
        step = "models";
      }
    };
    const moveProvider = (delta: number) => {
      providerIndex = Math.max(
        0,
        Math.min(providers.length - 1, providerIndex + delta),
      );
      modelIndex = 0;
    };
    const moveModel = (delta: number) => {
      modelIndex = Math.max(
        0,
        Math.min(Math.max(0, models().length - 1), modelIndex + delta),
      );
    };
    const moveTarget = (delta: number) => {
      targetIndex = Math.max(
        0,
        Math.min(
          Math.max(0, (followup?.items.length ?? 0) - 1),
          targetIndex + delta,
        ),
      );
    };
    const onKeypress = (character: string | undefined, key: Key) => {
      const sequence = key.sequence ?? character ?? "";
      if (mouseKeyBuffer || sequence.startsWith("\x1b[<")) {
        mouseKeyBuffer += sequence;
        for (const mouse of parseSgrMouseEvents(mouseKeyBuffer)) {
          handleMouse(mouse);
          if (finished) return;
        }
        if (/[Mm]$/.test(mouseKeyBuffer) || mouseKeyBuffer.length > 64) {
          mouseKeyBuffer = "";
        }
        return;
      }
      if (key.name === "escape" && step === "followup") {
        step = "models";
        render();
        return;
      }
      if (key.ctrl && key.name === "c" || key.name === "escape") {
        finish();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        if (step === "followup") {
          acceptTarget();
        } else if (pane === "providers") {
          pane = "models";
        } else {
          const selected = models()[modelIndex];
          if (selected) acceptModel(selected);
        }
        if (!finished) render();
        return;
      }
      if (step === "followup") {
        if (key.name === "up") {
          moveTarget(-1);
        } else if (key.name === "down" || key.name === "tab") {
          moveTarget(1);
        } else if (key.name === "pageup") {
          moveTarget(-maxVisible);
        } else if (key.name === "pagedown") {
          moveTarget(maxVisible);
        } else if (key.name === "home") {
          targetIndex = 0;
        } else if (key.name === "end") {
          targetIndex = Math.max(0, (followup?.items.length ?? 0) - 1);
        } else {
          return;
        }
        render();
        return;
      }
      if (key.name === "left") {
        pane = "providers";
      } else if (key.name === "right") {
        pane = "models";
      } else if (key.name === "tab") {
        pane = pane === "providers" ? "models" : "providers";
      } else if (key.name === "up") {
        pane === "providers" ? moveProvider(-1) : moveModel(-1);
      } else if (key.name === "down") {
        pane === "providers" ? moveProvider(1) : moveModel(1);
      } else if (key.name === "pageup") {
        pane === "providers"
          ? moveProvider(-maxVisible)
          : moveModel(-maxVisible);
      } else if (key.name === "pagedown") {
        pane === "providers"
          ? moveProvider(maxVisible)
          : moveModel(maxVisible);
      } else if (key.name === "home") {
        if (pane === "providers") {
          providerIndex = 0;
          modelIndex = 0;
        } else {
          modelIndex = 0;
        }
      } else if (key.name === "end") {
        if (pane === "providers") {
          providerIndex = providers.length - 1;
          modelIndex = 0;
        } else {
          modelIndex = Math.max(0, models().length - 1);
        }
      } else if (key.name === "backspace") {
        query = Array.from(query).slice(0, -1).join("");
        modelIndex = 0;
        pane = "models";
      } else if (key.ctrl && key.name === "u") {
        query = "";
        modelIndex = 0;
        pane = "models";
      } else if (
        character &&
        !key.ctrl &&
        !key.meta &&
        !/^[\u0000-\u001f\u007f]$/.test(character)
      ) {
        query += character;
        modelIndex = 0;
        pane = "models";
      } else {
        return;
      }
      render();
    };
    const handleMouse = (mouse: SgrMouseEvent) => {
      if (step === "followup") {
        if ((mouse.button & 64) !== 0) {
          if (!mouse.release) {
            moveTarget((mouse.button & 1) === 0 ? -1 : 1);
            render();
          }
          return;
        }
        if (!mouse.release || (mouse.button & 3) !== 0) return;
        const offset = mouse.row - firstItemRow;
        if (offset < 0 || offset >= maxVisible) return;
        const index = targetStart + offset;
        if (followup?.items[index]) {
          targetIndex = index;
          acceptTarget();
          if (!finished) render();
        }
        return;
      }
      const overProviders = mouse.column <= providerWidth + 1;
      if ((mouse.button & 64) !== 0) {
        if (mouse.release) return;
        const delta = (mouse.button & 1) === 0 ? -1 : 1;
        pane = overProviders ? "providers" : "models";
        overProviders ? moveProvider(delta) : moveModel(delta);
        render();
        return;
      }
      if (!mouse.release || (mouse.button & 3) !== 0) return;
      const offset = mouse.row - firstItemRow;
      if (offset < 0 || offset >= maxVisible) return;
      if (overProviders) {
        const index = providerStart + offset;
        if (providers[index]) {
          providerIndex = index;
          modelIndex = 0;
          pane = "providers";
          render();
        }
        return;
      }
      const selected = models()[modelStart + offset];
      if (selected) {
        acceptModel(selected);
        if (!finished) render();
      }
    };
    stdout.write("\x1b[?25l\x1b[?1000h\x1b[?1006h");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", onKeypress);
    render();
  });
}

export async function selectProviderModel<T>(
  title: string,
  providers: readonly ProviderModelPane<T>[],
  options: ProviderModelSelectOptions<T> = {},
): Promise<T | undefined> {
  return await selectProviderModelFlow<T, never>(
    title,
    providers,
    options,
  ) as T | undefined;
}

export async function selectProviderModelAndTarget<T, U>(
  title: string,
  providers: readonly ProviderModelPane<T>[],
  followup: FollowupSelectOptions<U>,
  options: ProviderModelSelectOptions<T> = {},
  targetBehavior?: ProviderModelTargetBehavior<T, U>,
): Promise<ProviderModelTargetSelection<T, U> | undefined> {
  return await selectProviderModelFlow(
    title,
    providers,
    options,
    followup,
    targetBehavior,
  ) as ProviderModelTargetSelection<T, U> | undefined;
}

export function ask(question: string): Promise<string> {
  return readLine(`${ansi.cyan}›${ansi.reset} ${question} `);
}

export function chatPrompt(
  completer?: LineCompleter,
  hintProvider?: LineHintProvider,
): Promise<string> {
  return readLine(`${ansi.cyan}›${ansi.reset} `, completer, hintProvider);
}

export async function readSecret(question: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    return ask(question);
  }
  stdout.write(`${ansi.cyan}›${ansi.reset} ${question} `);
  const wasRaw = stdin.isRaw;
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onData = (chunk: Buffer | string) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          finish(new Error("Login cancelled"));
          return;
        }
        if (character === "\r" || character === "\n" || character === "\u0004") {
          finish();
          return;
        }
        if (character === "\b" || character === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

export async function confirm(question: string): Promise<boolean> {
  const answer = (await ask(`${question} ${ansi.dim}[y/N]${ansi.reset}`)).toLowerCase();
  return answer === "y" || answer === "yes";
}

export const palette = ansi;
