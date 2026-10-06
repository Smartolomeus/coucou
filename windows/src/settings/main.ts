// Settings window — the place where anything that writes to disk is confirmed.
// Stage 2 covers the Claude Code hooks and the general preferences; API keys and
// integrations land here too in a later stage.

import "./settings.css";
import { Bridge, onEvent, type HookStatus } from "../core/bridge";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { h, clear } from "../views/dom";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "#22c55e" : "#f4505e"}` });
}

function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

// ── Claude Code section ───────────────────────────────────────────────────────

function claudeSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h(
    "section",
    {},
    h("h2", {}, statusDot(status.installed), h("span", { text: "Claude Code" })),
    body,
  );

  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    clear(body);
    draw();
    const head = section.querySelector("h2")!;
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: "Claude Code" }));
  };

  function draw() {
    body.append(
      h("div", {
        class: "hint",
        text: status.installed
          ? "Coucou ist in deine Claude-Code-Sitzungen eingebunden. Tool-Aufrufe, Fragen und Berechtigungsanfragen erscheinen in der Insel, und du kannst sie dort direkt beantworten."
          : "Installiere die Hooks, um deine Claude-Code-Sitzungen in der Insel zu sehen und Berechtigungen freizugeben, ohne deine Arbeit zu unterbrechen.",
      }),
      h("div", { class: "row" },
        h("label", { text: "settings.json" }),
        h("span", { class: "path", text: status.settingsPath }),
      ),
      h("div", { class: "row" },
        h("label", { text: "Relay" }),
        h("span", { class: "path", text: status.hookPath }),
        statusDot(status.hookReady),
      ),
    );

    if (!status.hookReady) {
      body.append(h("div", {
        class: "notice warn",
        text: "coucou-hook.exe ist noch nicht vorhanden. Starte Coucou neu; fehlt sie danach immer noch, baue sie mit `cargo build -p coucou-hook`.",
      }));
    }

    const actions = h("div", { class: "row" });
    const install = h("button", {
      class: "primary",
      text: status.installed ? "Hooks neu installieren…" : "Hooks installieren…",
      onclick: () => showPreview(true),
    });
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook and nothing to show for it.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = "Das Relay ist noch nicht installiert.";
    }
    actions.append(install);
    if (status.installed) {
      actions.append(h("button", {
        class: "danger",
        text: "Hooks deinstallieren…",
        onclick: () => showPreview(false),
      }));
    }
    body.append(actions);
  }

  async function showPreview(install: boolean) {
    let preview;
    try {
      preview = await Bridge.hooksPreview(install);
    } catch (err) {
      // An unreadable or invalid settings.json stops here rather than being
      // treated as empty and written over.
      clear(body);
      body.append(
        h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
        h("div", { class: "row" }, h("button", {
          text: "Zurück",
          onclick: () => { clear(body); draw(); },
        })),
      );
      return;
    }
    if (!preview) return;
    clear(body);
    body.append(
      h("div", {
        class: "hint",
        text: install
          ? "Genau das wird in deiner settings.json geändert. Deine eigenen Hooks bleiben unangetastet."
          : "Es werden nur die Einträge von Coucou entfernt. Deine eigenen Hooks bleiben unangetastet.",
      }),
      renderDiff(preview.diff),
      h("div", { class: "row" },
        h("span", { class: "path", text: `Backup → ${preview.backup}` }),
      ),
    );
    const confirm = h("button", {
      class: install ? "primary" : "danger",
      text: install ? "Sichern und schreiben" : "Sichern und entfernen",
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        const backup = await Bridge.hooksApply(install, preview.fingerprint);
        clear(body);
        body.append(h("div", {
          class: "notice ok",
          text: `Fertig. Die bisherigen Einstellungen wurden als ${backup} gesichert. Öffne eine neue Claude-Code-Sitzung, damit die Hooks greifen.`,
        }));
        window.setTimeout(() => void rebuild(), 2600);
      } catch (err) {
        confirm.disabled = false;
        body.append(h("div", { class: "notice err", text: `Schreiben fehlgeschlagen: ${String(err)}` }));
      }
    });
    body.append(h("div", { class: "row" }, confirm, h("button", {
      text: "Abbrechen",
      onclick: () => { clear(body); draw(); },
    })));
  }

  draw();
  return section;
}

// ── Chat: provider and API keys ───────────────────────────────────────────────

const CLAUDE_MODELS: [string, string][] = [
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-haiku-4-5", "Claude Haiku 4.5"],
];

/** Suggestions only: the field takes any model name OpenAI offers. */
const OPENAI_MODELS = ["gpt-5", "gpt-5-mini", "gpt-5-nano"];

function chatSection(): HTMLElement {
  const provider = h("select", {}) as HTMLSelectElement;
  provider.append(
    h("option", { value: "anthropic", text: "Claude (Anthropic)" }),
    h("option", { value: "openai", text: "ChatGPT (OpenAI)" }),
  );
  provider.value = settings.chatProvider;
  provider.addEventListener("change", () => {
    settings.chatProvider = provider.value as Settings["chatProvider"];
    void save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Chat" })),
    h("div", { class: "hint", text: "Wer in der Insel antwortet. Den Schlüssel für den gewählten Anbieter trägst du darunter ein." }),
    h("div", { class: "row" }, h("label", { text: "Chat-Anbieter" }), provider),
  );
}

function claudeModelControl(): HTMLElement {
  const model = h("select", {}) as HTMLSelectElement;
  for (const [id, label] of CLAUDE_MODELS) model.append(h("option", { value: id, text: label }));
  if (!CLAUDE_MODELS.some(([id]) => id === settings.model)) {
    model.append(h("option", { value: settings.model, text: settings.model }));
  }
  model.value = settings.model;
  model.addEventListener("change", () => {
    settings.model = model.value;
    void save();
  });
  return model;
}

function openaiModelControl(): HTMLElement {
  const listId = "openai-models";
  const model = h("input", {
    type: "text",
    list: listId,
    placeholder: "gpt-5",
    style: "flex:1 1 auto;min-width:0;max-width:240px",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  model.value = settings.openaiModel;
  model.addEventListener("change", () => {
    settings.openaiModel = model.value.trim() || DEFAULT_SETTINGS.openaiModel;
    model.value = settings.openaiModel;
    void save();
  });
  return h(
    "span",
    { style: "display:contents" },
    model,
    h("datalist", { id: listId }, ...OPENAI_MODELS.map((m) => h("option", { value: m }))),
  );
}

interface KeySectionDef {
  title: string;
  /** Credential Manager entry. */
  secret: string;
  placeholder: string;
  hasKey: boolean;
  model: HTMLElement;
  /** Extra line under the status, for what the user should know about this provider. */
  note?: string;
}

function keySection(def: KeySectionDef): HTMLElement {
  const dot = statusDot(def.hasKey);
  const MISSING = "Noch kein Schlüssel – der Chat braucht einen.";
  const STORED = "Schlüssel in der Windows-Anmeldeinformationsverwaltung gespeichert.";
  const state = h("span", { class: "hint", text: def.hasKey ? STORED : MISSING });

  const field = h("input", {
    type: "password",
    placeholder: def.hasKey ? "••••••••••••  (stored)" : def.placeholder,
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const saveBtn = h("button", { class: "primary", text: "Schlüssel speichern" });
  const clearBtn = h("button", { class: "danger", text: "Entfernen" });
  const feedback = h("div", {});

  async function refresh() {
    const present = (await Bridge.secretPresent(def.secret)) ?? false;
    dot.style.background = present ? "#22c55e" : "#f4505e";
    state.textContent = present ? STORED : MISSING;
    field.placeholder = present ? "••••••••••••  (stored)" : def.placeholder;
    clearBtn.style.display = present ? "" : "none";
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet(def.secret, value);
      field.value = "";
      feedback.append(h("div", { class: "notice ok", text: "Gespeichert. Der Schlüssel wird nie auf der Festplatte abgelegt." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Speichern fehlgeschlagen: ${String(err)}` }));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear(def.secret);
      feedback.append(h("div", { class: "notice ok", text: "Schlüssel entfernt." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Entfernen fehlgeschlagen: ${String(err)}` }));
    }
  });

  clearBtn.style.display = def.hasKey ? "" : "none";

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: def.title })),
    state,
    def.note ? h("div", { class: "hint", text: def.note }) : null,
    h("div", { class: "row" }, h("label", { text: "API-Schlüssel" }), field, saveBtn, clearBtn),
    h("div", { class: "row" }, h("label", { text: "Modell" }), def.model),
    feedback,
  );
}

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: "Secret Key", placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [{ key: "github-token", label: "Token", placeholder: "ghp_…", secret: true }] },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
    fields: [{ key: "vercel-token", label: "Token", placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38",
    fields: [
      { key: "n8n-url", label: "Instanz-URL", placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: "API-Schlüssel", placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [{ key: "resend-api-key", label: "API-Schlüssel", placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: "Token", placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: "API-Schlüssel", placeholder: "cal_…", secret: true }] },
];

const MAX_ACTIVE = 4;

function integrationsSection(present: Record<string, boolean>): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  function updateNote() {
    const used = settings.activeIntegrations.length;
    note.textContent = `Wähle bis zu ${MAX_ACTIVE} Dienste, die als Pills neben Mochi erscheinen – ${used}/${MAX_ACTIVE} belegt. Schlüssel liegen in der Windows-Anmeldeinformationsverwaltung, nie auf der Festplatte.`;
  }

  for (const def of INTEGRATIONS) {
    const active = settings.activeIntegrations.includes(def.id);
    const sw = h("button", { class: active ? "switch on" : "switch" });
    sw.addEventListener("click", () => {
      const on = settings.activeIntegrations.includes(def.id);
      if (on) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        if (settings.activeIntegrations.length >= MAX_ACTIVE) return;
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      sw.classList.toggle("on", !on);
      updateNote();
      void save();
    });

    const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0" });
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? "••••••••  (stored)" : field.placeholder,
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: "Speichern" });
      const dotEl = statusDot(present[field.key] ?? false);
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = value.length > 0;
          input.value = "";
          input.placeholder = value ? "••••••••  (stored)" : field.placeholder;
          dotEl.style.background = value ? "#22c55e" : "#f4505e";
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      rows.append(
        h("div", { class: "row" },
          h("label", { style: "min-width:104px", text: field.label }),
          input, saveBtn, dotEl,
        ),
      );
    }

    list.append(
      h("div", { style: "display:flex;gap:12px;align-items:flex-start" },
        h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
          sw,
          h("i", { class: "dot", style: `background:${def.color}` }),
          h("span", { style: "font-size:12.5px", text: def.name }),
        ),
        rows,
      ),
    );
  }

  updateNote();
  return h("section", {}, h("h2", {}, h("span", { text: "Integrationen" })), note, list);
}

// ── General section ───────────────────────────────────────────────────────────

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  const autoClose = h("input", {
    type: "number", min: "5", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(5, Math.min(120, Number(autoClose.value) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: "Hauptbildschirm" }),
    h("option", { value: "cursor", text: "Bildschirm unter dem Mauszeiger" }),
  );
  screen.value = settings.screen;
  screen.addEventListener("change", () => {
    settings.screen = screen.value as Settings["screen"];
    void save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Allgemein" })),
    h("div", { class: "row" },
      h("label", { text: "Ton" }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
      volume,
    ),
    h("div", { class: "row" },
      h("label", { text: "Automatisch schließen" }),
      autoClose,
      h("span", { class: "hint", text: "Sekunden, nachdem du die Insel verlässt" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Insel erscheint auf" }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: "Mit Windows starten" }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
  );
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }
  const status = (await Bridge.hooksStatus()) ?? {
    installed: false, settingsPath: "", hookPath: "", hookReady: false,
  };

  const hasKey = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
  const hasOpenaiKey = (await Bridge.secretPresent("openai-api-key")) ?? false;

  const keys = [
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;

  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Coucou" }), h("span", { class: "version", text: version })),
    claudeSection(status),
    chatSection(),
    keySection({
      title: "Claude",
      secret: "anthropic-api-key",
      placeholder: "sk-ant-...",
      hasKey,
      model: claudeModelControl(),
    }),
    keySection({
      title: "ChatGPT",
      secret: "openai-api-key",
      placeholder: "sk-...",
      hasKey: hasOpenaiKey,
      model: openaiModelControl(),
      note: "Der Chat nutzt die OpenAI-API (platform.openai.com), nicht dein ChatGPT-Abo. Websuche ist hier nicht dabei.",
    }),
    integrationsSection(present),
    generalSection(),
    h("div", {
      class: "hint",
      text: "Keine Telemetrie. Netzwerkanfragen gehen nur an die Dienste, die du selbst einrichtest.",
    }),
  );

  void onEvent<Settings>("settings-changed", (s) => {
    settings = { ...settings, ...s };
  });
}

void main();
