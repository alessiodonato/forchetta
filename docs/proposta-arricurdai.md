# Proposta per arricurdAI: `handoff --prepare`

Stato: **fatta**, in arricurdAI 0.5.0. Forchetta la usa da sola quando l'arricurdAI installato è almeno la 0.5.0: prima di un `/clear` dal box, la sessione nuova riceve la nota su quella vecchia. Il codice vero è `prepareHandoff` in `packages/cli/src/guard.ts` di arricurdAI. Il resto della pagina è la proposta com'era, con il codice indicativo.

Prima di proporla l'avevo provata su una copia di arricurdAI: i test passavano (138, tre nuovi), e con Forchetta collegata alla copia un `/clear` dal box ha dato alla sessione nuova la nota ("Last requests of the user…, Files changed…, Last reply of the assistant").

## Il problema

Forchetta può mandare `/clear` a una sessione dal suo box. Il requisito è che, prima, arricurdAI salvi lo stato della sessione, così che la sessione nuova riceva la nota su quella vecchia: le ultime richieste, i file cambiati, i compiti aperti, l'ultima risposta.

In arricurdAI 0.4.0 la nota nasce in un solo caso. Il guard (`UserPromptSubmit`) ferma un prompt dopo una pausa e scrive un marker in `$TMPDIR/arricurdai-<uid>/handoff-<cartella>.json`. Poi `handoff` (`SessionStart` con `source: "clear"`) trova il marker e scrive la nota. Non esiste un comando per chiederla in altri momenti.

## La proposta

Un'opzione di `handoff`:

```
arricurdai handoff --prepare --transcript <percorso del transcript>
```

- Scrive lo stesso marker che scrive `runGuard`, per quel transcript, e non stampa nulla.
  - Nel marker non c'è un prompt fermato, quindi la nota non conterrà "earlier context that matches the prompt".
- Esce con 0 se il marker è scritto, con 1 e un messaggio su stderr se il transcript non esiste o se la cartella di stato non è privata.
- `arricurdai handoff --help` elenca `--prepare`: Forchetta lo riconosce così.

`afterClear` non cambia. Alla prossima `SessionStart` con `source: "clear"` nella stessa cartella di progetto trova il marker e scrive la nota, come oggi.

### Codice indicativo

In `packages/cli/src/guard.ts`, accanto a `runGuard`:

```ts
/** `handoff --prepare`: the note on this session for the next /clear in its project, asked for by a tool. */
export function prepareHandoff(transcript: string, io: Pick<HookIO, 'stateDir' | 'now'>): void {
  if (!existsSync(transcript)) throw new UserError(`no transcript at ${transcript}`);
  if (!openPrivateDir(io.stateDir)) throw new UserError(`${io.stateDir} is not a private folder`);
  const call = lastCall(readTail(transcript));
  const marker = { transcript, context: call?.context ?? 0, at: io.now().getTime() };
  writeFileSync(markerPath(io.stateDir, transcript), JSON.stringify(marker), { mode: 0o600 });
}
```

In `bin.ts`, il comando `handoff` riceve le due opzioni:
- con `--prepare` chiama `prepareHandoff`;
- senza `--prepare` resta l'hook di oggi, che legge stdin.

### Test suggeriti

- `--prepare` seguito da `runHandoff` con `source: "clear"` e un altro transcript della stessa cartella produce la nota.
- `--prepare` su un transcript che non esiste esce con 1 e non scrive nulla.
- Un marker scritto da `--prepare` più vecchio di `MARKER_MAX_AGE` non produce la nota, come quelli del guard.

### Un limite da sapere

Il marker vale per cartella di progetto: con due sessioni nello stesso progetto, la nota va al primo `/clear` che arriva. Forchetta manda `/clear` subito dopo `--prepare`, quindi in pratica è quello giusto. Un marker per sessione (`handoff-<session_id>.json`) toglierebbe anche questo caso, ma cambierebbe `afterClear`.

## E `/compact`?

Non serve niente:
- il transcript resta intero su disco;
- dopo una compattazione `handoff` aggiunge già da solo la riga su come usare `recall`;
- `recall` trova quello che il riassunto ha lasciato fuori.

## Cosa fa già Forchetta

`src/daemon/arricurdai.ts`, classe `ArricurdaiNotes`:

- All'avvio il daemon esegue `arricurdai handoff --help` e cerca `--prepare`.
- **Se c'è:**
  - prima di ogni `/clear` mandato da un box esegue `handoff --prepare --transcript <transcript della sessione>`;
  - se fallisce, `/clear` non parte e il box dice perché.
- **Se non c'è, come con la 0.4.0:** `/clear` parte, e la finestra di conferma dice che arricurdAI non può salvare una nota in questa versione e che il transcript resta su disco per `recall`.
