# Codex und ChatGPT in Coucou (Windows)

Zwei getrennte Erweiterungen, beide in diesem Fork ergänzt:

1. **Codex-Pill:** Sitzungen von [Codex CLI](https://developers.openai.com/codex/hooks) erscheinen in der Insel, mit den Schritten, die Codex gerade ausführt.
2. **ChatGPT im Chat:** Der Chat in der Insel kann statt mit Claude mit ChatGPT sprechen.

> Beides ist nur unter Linux gebaut und getestet (Unit-Tests, Mock-Server, Vorschau der Oberfläche). Mit echtem Codex und einem echten OpenAI-Schlüssel auf Windows wurde es noch **nicht** ausprobiert.

## Codex-Pill

### Einrichten

Voraussetzung: Coucou wurde mindestens einmal gestartet, damit `coucou-hook.exe` unter `%LOCALAPPDATA%\Coucou\bin\` liegt.

In PowerShell, im Ordner `windows` des Projekts:

```powershell
node scripts\codex-hooks.mjs status       # zeigt, was schon eingetragen ist
node scripts\codex-hooks.mjs install      # zeigt die Änderung und fragt nach
```

Das Skript trägt fünf Hooks in `%USERPROFILE%\.codex\hooks.json` ein (oder in `$CODEX_HOME\hooks.json`, falls gesetzt): `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`. Jeder ruft `coucou-hook.exe --agent codex <Ereignis>` auf.

Es hält sich an dieselben Regeln wie der Claude-Code-Installer: erst ein Backup mit Datum, dann ein Zusammenführen, das fremde Hooks und alle anderen Einträge unangetastet lässt, und geschrieben wird erst nach deiner Bestätigung. Eine kaputte `hooks.json` wird nicht überschrieben.

Danach Codex neu starten. Falls Codex nach einer Freigabe oder einem Vertrauen für die neuen Hooks fragt, bestätige das. Die Hook-Funktion von Codex ist neu, und genau wie die Freigabe abläuft, habe ich nicht prüfen können.

Entfernen:

```powershell
node scripts\codex-hooks.mjs uninstall
```

### Ohne Codex testen

Ob die Pill in der Insel erscheint, lässt sich ohne Codex prüfen. Coucou muss laufen:

```powershell
'{"hook_event_name":"UserPromptSubmit","session_id":"t1","prompt":"Test","coucou_agent":"demo"}' | & "$env:LOCALAPPDATA\Coucou\bin\coucou-hook.exe" --agent demo
```

Eine Pill „demo" sollte erscheinen. Für Codex heißt sie „Codex" und ist grün.

### Grenzen

- **Keine Erlauben/Ablehnen-Karte für Codex.** Im Projekt gibt es Freigaben nur für Claude Code. Codex fragt wie gewohnt im Terminal.
- **Nur die fünf Ereignisse oben.** Weitere Codex-Ereignisse werden nicht weitergegeben.
- **Bekannter Fehler in Codex unter Windows:** Beim `Stop`-Ereignis kann Codex Text mit Umlauten fehlerhaft kodieren ([openai/codex#23784](https://github.com/openai/codex/issues/23784), so gemeldet; ich weiß nicht, ob es inzwischen behoben ist). Das Relay verwirft dann das Ereignis stillschweigend, und die Pill bleibt auf „arbeitet", bis du Coucou neu startest. Claude Code ist davon nicht betroffen.
- Die Pill erscheint erst, wenn Codex etwas meldet, und du musst sie anklicken, um ihre Schritte zu sehen. Das ist bei allen fremden Agenten so.

## ChatGPT im Chat

**Einstellungen → Chat → Chat-Anbieter** auf „ChatGPT (OpenAI)" stellen, dann unter „ChatGPT" den Schlüssel und das Modell eintragen.

- **Schlüssel:** Er kommt von [platform.openai.com](https://platform.openai.com) (API keys). Ein ChatGPT-Abo (Plus, Pro) ist **kein** API-Zugang. Die API wird getrennt nach Verbrauch abgerechnet und braucht dort ein Guthaben. Gespeichert wird der Schlüssel in der Windows-Anmeldeinformationsverwaltung, wie die anderen.
- **Modell:** Vorgabe ist `gpt-5`. Das Feld nimmt jeden Modellnamen, den OpenAI anbietet. Ist der Name falsch, zeigt die Insel die Fehlermeldung der API.
- **Dateien:** Eine abgelegte Datei geht wie bei Claude mit der ersten Frage mit (Text und Code, Bilder, PDF).
- **Ohne Websuche.** Der Claude-Chat kann im Web suchen, der ChatGPT-Chat nicht.
- Claude und ChatGPT führen getrennte Verläufe. Beim Wechsel des Anbieters beginnt der neue Anbieter ohne die bisherige Unterhaltung.
