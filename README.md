# Battleship Helfer 🎯

Kleiner Helfer für „Schiffe versenken“. Er läuft komplett im Browser und rechnet nach
jedem Zug neu:

- **Heatmap** der Trefferwahrscheinlichkeit (umschaltbar auf **Entropie**)
- **Empfehlung** für den nächsten Schuss, dazu die Top 5 als Tabelle
- **Schachbrett-/Paritätsraster**: jedes k-te Feld, k = kürzestes verbleibendes Schiff
- Du klickst ein Feld an und meldest **Wasser / Treffer / Versenkt** (Tasten `W` / `T` / `V`)
- Bei **Versenkt** wird der Rand automatisch gesperrt und das Schiff aus der Flotte
  gestrichen. Raster und Rechnung passen sich an.
- **Übung/Demo**: Der Computer versteckt eine Zufallsaufstellung. Du kannst selbst
  spielen oder den Bot spielen lassen („Auto ▶“).
- Feldgröße, Flotte und die Diagonal-Regel sind in den Einstellungen änderbar.

## Standardregeln

- 9×9-Feld
- Flotte: 3 × 4er und 5 × 3er
- Schiffe nur waagrecht oder senkrecht
- Schiffe berühren sich nicht, auch nicht diagonal (umschaltbar)
- Treffer = nochmal schießen

## Starten

Wegen der JavaScript-Module muss die Seite über einen (lokalen) Webserver laufen.
Per Doppelklick auf die Datei geht es nicht.

```bash
python3 -m http.server 8000
# dann http://localhost:8000 öffnen
```

### Kostenlos hosten mit GitHub Pages

1. Das Repo muss **öffentlich** sein. Für private Repos braucht GitHub Pages einen bezahlten Plan.
2. Auf GitHub: *Settings → Pages → Build and deployment → Source: „Deploy from a branch“*
3. Branch `main` (oder diesen Branch) und Ordner `/ (root)` wählen, dann speichern.
4. Nach ca. 1 Minute ist die Seite unter `https://<user>.github.io/battleship-bot/` erreichbar.

Es gibt keinen Build-Schritt, alles ist statisch.

## Wie gerechnet wird

1. **Ganze Flottenaufstellungen statt einzelner Schiffe.** Gezählt werden alle
   Aufstellungen der *gesamten* Flotte, die zu allen Beobachtungen passen. Dabei gilt:
   - kein Schiff auf Wasser
   - jeder offene Treffer liegt unter genau einem Schiff
   - Schiffe berühren sich nicht
   - kein Schiff besteht nur aus Treffern, sonst wäre es schon als versenkt gemeldet worden

   Weil die Aufstellung zufällig ist, ist jede passende Aufstellung gleich wahrscheinlich.
   Der Anteil der Aufstellungen mit einem Schiff auf Feld X ist also die Trefferwahrscheinlichkeit.
   Zählt man jedes Schiff einzeln, ist das nur eine Näherung, weil sich Schiffe gegenseitig ausschließen.
2. **Stichprobe oder exakte Zählung.** Am Anfang gibt es ~2·10⁸ Aufstellungen. Komplett
   durchzählen dauert über 100 s, daher wird eine gewichtete Zufallsstichprobe gezogen
   (Sequential Importance Sampling, ~0,2–0,4 s). Ablauf:
   - Zuerst werden die offenen Treffer abgedeckt.
   - Danach werden die restlichen Schiffe gelegt, die großen zuerst.
   - Jede Stichprobe wird so gewichtet, dass das Ergebnis unverzerrt ist.

   Sobald nur noch wenige Aufstellungen möglich sind, wird **exakt** gezählt.
3. **Entropie.** Pro Feld gibt es drei mögliche Antworten: Wasser, Treffer oder Versenkt.
   Deren Entropie misst, wie viel ein Schuss im Mittel über die Aufstellung verrät.
4. **Schussauswahl.**
   - Felder mit 0 % werden nie beschossen.
   - Sichere Treffer (100 %) kommen zuerst. Sie kosten keinen Zug und müssen ohnehin
     geschossen werden.
   - Sonst entscheidet die gewählte Strategie.
   - Bei Gleichstand gewinnt ein Rasterfeld.

### Strategien im Vergleich

`node bench/bench.mjs 400 8000`: 400 zufällige Aufstellungen, jede Strategie spielt
dieselben Aufstellungen.

| Strategie | Fehlschüsse Ø | Median | Schüsse Ø |
|---|---|---|---|
| **Info pro Fehlschuss** (Standard): Entropie ÷ Fehlschuss-Risiko | **8,95** | 9 | 35,95 |
| Max. Trefferwahrscheinlichkeit | 9,01 | 9 | 36,01 |
| Max. Entropie | 11,49 | 12 | 38,49 |

Bei „Treffer = nochmal schießen“ zählen nur die Fehlschüsse, denn Treffer sind gratis.
Reine Entropie schießt gern auf 50/50-Felder und verliert dadurch ~2,5 Fehlschüsse pro Spiel.
„Info pro Fehlschuss“ und reine Wahrscheinlichkeit liegen gleichauf. Der Unterschied
(−0,05 ± 0,06) ist statistisch nicht messbar.

## Entwicklung

```bash
npm test        # Engine gegen naive Brute-Force-Zählung prüfen
npm run bench   # Strategien vergleichen
```

Dateien:

- `src/engine.js`: Rechnung (läuft auch in Node)
- `src/worker.js`: Web Worker, der die Rechnung im Hintergrund ausführt
- `src/app.js`: Oberfläche
