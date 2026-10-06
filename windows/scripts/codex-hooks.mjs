// Adds or removes Coucou's hooks in Codex's hooks.json, so Codex sessions get
// their own pill in the island.
//
//   node scripts/codex-hooks.mjs status
//   node scripts/codex-hooks.mjs install   [--yes]
//   node scripts/codex-hooks.mjs uninstall [--yes]
//
// Same rules as the Claude Code installer in the settings window: a dated
// backup first, a merge that never touches anybody else's hooks, and nothing is
// written before you confirm (--yes answers for you).
//
// Codex's config folder is $CODEX_HOME, or ~/.codex when that is not set.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

const AGENT = "codex";
/** The events Codex documents for hooks. Coucou treats them like Claude Code's. */
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];
/** Events that carry a tool name; a matcher is part of their documented shape. */
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);
/** Seconds. The relay answers in milliseconds, or exits when Coucou is closed. */
const TIMEOUT = 10;

const codexDir = process.env.CODEX_HOME || join(homedir(), ".codex");
const hooksPath = join(codexDir, "hooks.json");

/** Where Coucou puts its relay at launch. */
function relayPath() {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(local, "Coucou", "bin", "coucou-hook.exe").replaceAll("\\", "/");
  }
  return join(homedir(), ".local", "share", "coucou", "bin", "coucou-hook");
}

/** Unquoted when it can be: a bare path works in cmd, PowerShell and sh alike. */
function commandFor(event) {
  const exe = relayPath();
  const shown = /[\s"'&|<>()^;$`]/.test(exe) ? `"${exe}"` : exe;
  return `${shown} --agent ${AGENT} ${event}`;
}

/** Ours = a command that runs coucou-hook for the codex agent. */
function isOurs(hook) {
  return (
    typeof hook?.command === "string" &&
    hook.command.includes("coucou-hook") &&
    hook.command.includes(`--agent ${AGENT}`)
  );
}

function readConfig() {
  if (!existsSync(hooksPath)) return {};
  let text = readFileSync(hooksPath, "utf8").replace(/^﻿/, "");
  if (text.trim() === "") return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${hooksPath} ist kein gültiges JSON (${err.message}). Korrigiere oder verschiebe die Datei — das Skript überschreibt sie nicht.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${hooksPath} ist kein JSON-Objekt — das Skript rührt die Datei nicht an.`);
  }
  return parsed;
}

function groupsOf(config, event) {
  const groups = config.hooks?.[event];
  return Array.isArray(groups) ? groups : [];
}

function isInstalled(config) {
  return EVENTS.every((event) => groupsOf(config, event).some((g) => (g.hooks ?? []).some(isOurs)));
}

/** A new config with our entries added; everything else stays as it was. */
function merged(config) {
  const next = structuredClone(config);
  if (next.hooks === undefined || next.hooks === null) next.hooks = {};
  for (const event of EVENTS) {
    const command = commandFor(event);
    const groups = Array.isArray(next.hooks[event]) ? next.hooks[event] : (next.hooks[event] = []);
    let found = false;
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        if (isOurs(hook)) {
          hook.command = command; // the relay may have moved
          found = true;
        }
      }
    }
    if (!found) {
      const group = { hooks: [{ type: "command", command, timeout: TIMEOUT }] };
      if (TOOL_EVENTS.has(event)) group.matcher = ".*";
      groups.push(group);
    }
  }
  return next;
}

/** A new config without our entries; empty groups and events we leave behind are dropped. */
function without(config) {
  const next = structuredClone(config);
  if (!next.hooks) return next;
  for (const event of Object.keys(next.hooks)) {
    if (!Array.isArray(next.hooks[event])) continue;
    next.hooks[event] = next.hooks[event]
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((hook) => !isOurs(hook)) }))
      .filter((g) => g.hooks.length > 0);
    if (next.hooks[event].length === 0) delete next.hooks[event];
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}

/** Every Coucou entry in a config, one line each: "Event: command". */
function ourEntries(config) {
  const lines = [];
  for (const [event, groups] of Object.entries(config.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        if (isOurs(hook)) lines.push(`${event}: ${hook.command}`);
      }
    }
  }
  return lines;
}

/** What changes, as the entries that come and go. Everything else is untouched by construction. */
function summary(before, after) {
  const a = ourEntries(before);
  const b = ourEntries(after);
  return [
    ...b.filter((line) => !a.includes(line)).map((line) => `+ ${line}`),
    ...a.filter((line) => !b.includes(line)).map((line) => `- ${line}`),
  ].join("\n");
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function confirm(question, yes) {
  if (yes) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [j/N] `)).trim().toLowerCase();
    return answer === "j" || answer === "ja" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function write(config) {
  mkdirSync(dirname(hooksPath), { recursive: true });
  let backup = null;
  if (existsSync(hooksPath)) {
    backup = `${hooksPath}.bak-${stamp()}`;
    copyFileSync(hooksPath, backup);
  }
  const temp = `${hooksPath}.coucou-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(temp, hooksPath);
  return backup;
}

async function change(install, yes) {
  const current = readConfig();
  const next = install ? merged(current) : without(current);
  if (JSON.stringify(current) === JSON.stringify(next)) {
    console.log(install ? "Die Codex-Hooks von Coucou sind bereits eingetragen." : "Es sind keine Codex-Hooks von Coucou eingetragen.");
    return;
  }
  console.log(`Datei: ${hooksPath}\n`);
  console.log(summary(current, next));
  console.log("\nAlle anderen Einträge in der Datei, auch deine eigenen Hooks, bleiben unverändert.");
  console.log(
    existsSync(hooksPath)
      ? `\nVor dem Schreiben wird ein Backup angelegt: ${hooksPath}.bak-<Datum>`
      : "\nDie Datei existiert noch nicht und wird neu angelegt.",
  );
  if (!(await confirm(install ? "Jetzt eintragen?" : "Jetzt entfernen?", yes))) {
    console.log("Abgebrochen. Es wurde nichts geändert.");
    return;
  }
  const backup = write(next);
  console.log(backup ? `Fertig. Backup: ${backup}` : "Fertig.");
  if (install) console.log("Starte Codex neu, damit die Hooks gelesen werden.");
}

function status() {
  const config = readConfig();
  const relay = relayPath();
  console.log(`Datei:   ${hooksPath} ${existsSync(hooksPath) ? "" : "(existiert nicht)"}`);
  console.log(`Relay:   ${relay} ${existsSync(relay) ? "(vorhanden)" : "(FEHLT — starte Coucou einmal)"}`);
  console.log(`Hooks:   ${isInstalled(config) ? "eingetragen" : "nicht (vollständig) eingetragen"}`);
}

const [command, ...flags] = process.argv.slice(2);
const yes = flags.includes("--yes");

try {
  if (command === "status") status();
  else if (command === "install") await change(true, yes);
  else if (command === "uninstall") await change(false, yes);
  else {
    console.log("Aufruf: node scripts/codex-hooks.mjs <status|install|uninstall> [--yes]");
    process.exitCode = command ? 1 : 0;
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
