# Handoff: conversation fixes, Oct 31

Branch `claude/console-menu` (worktree `hackathon-claude-menu`), uncommitted. Built on the uncommitted console and
intro work already in the worktree; none of it reverted. Brief: Angel's approved items 1-13 on how the assistant
talks to customers.

## What changed, by item

1. **Never silent.** The pretend engine never returns `nothing` for a burst. It says the step again: the open
   question, the same readback (same version), or the order's status. With no order it asks `what_to_order`. The
   order handler adds a last guard (`neverSilent`). A job that closes a burst and would send nothing sends the
   pending question, "¿Qué más te mando?", or "¡A la orden! 🙌" (log `silent_reply_filled`). A second tap of a
   button that was already answered gets a reply too.
2. **Name at the end.** The engine doesn't ask the name while the order is being built. The customer can say yes
   to the readback by tapping Confirmar, typing "confirmar", typing a yes, or typing "1". With no name on file, the
   reply is "¡Va! ¿A nombre de quién lo anoto?" and the confirmation is held (order, version, operation key). The
   name is checked by code (`src/domain/customer-name.ts`) and saved, and it completes the held confirmation under
   the held key, so a later tap of the old Confirmar is a duplicate. An answer that isn't a name ("sí", "ok", a
   number, an emoji, a product, more than 4 words) gets "¿Me decís tu nombre para anotar el pedido? 🙏" once.
   After a second answer that isn't a name, the order is confirmed without one. A name given earlier ("soy
   Carla") is never asked for. The confirmation now uses the name: "Listo, Carla, tu pedido ya está en la lista…".
3. **Typed yes = Confirmar.** The words are "sí", "si", "dale", "va", "ok", "listo", "confirmo", "así está bien"
   and "👍", as the whole message, in any case or accent. A yes counts only when the last message queued before it
   carried that readback version's Confirmar button, and it uses the button's operation key. Otherwise it's read
   as before.
4. **Thanks / ok.** With nothing pending: "¡A la orden! 🙌" (no model call). With a readback that was sent and is
   waiting: "Para dejarlo listo, tocá Confirmar ✅", with the readback's buttons on that same message. Without
   buttons it says "respondé Confirmar". A readback that was never sent (held back because the customer wrote
   while it was being built) goes out in full instead.
5. **Greeting mid-conversation.** "¡Buenas, Carla! 👋" (or "¡Buenas! 👋" with no name) and then the order's step,
   in one message, with no model call. A new customer's greeting still gets the intro.
6. **Question + order in one message.** `EngineResult.answered` (proposed) carries the answer from records. The
   reply gives the answer first, then the step, in one message, and keeps both parts' claims.
7. **A number after options.** "1", "2" or "3" alone is the button at that place on the last message queued to the
   conversation before the number arrived (`ButtonsShown.lastButtons`; `D1ButtonsShown` reads
   `outbound_messages.buttons_json`, scoped to the store and conversation). If that message had no buttons, the
   number is read as usual, never guessed.
8. **Stop in other words** (`asksToStop`). Phrases like "no me manden más" get "¿Pauso los mensajes? 🙏" with a
   "Sí, pausar" button (`control:stop`), which the gate treats as ALTO. ALTO itself is unchanged. ALTO's
   confirmation now reads "Listo, pausé los mensajes… Si necesitás hablar con {owner}, pedímelo y le aviso."
9. **Failure copy.** A text message that failed every attempt gets "Se lo pasé a la tienda para que te ayuden 🙏",
   and a `customer_handoff` Pendientes item is raised first (`processor.ts`). A photo or voice note is still
   asked for once more.
10. **No time promises.** Handoff: "Se lo dejo anotado a {owner}, te escribe por aquí." (both the engine's handoff
    and the typed one). Slow notice: "Recibimos tu mensaje, lo estamos revisando."
11. **"Tocá…" only with buttons.** A substitute offer without buttons ends with "Escribime qué preferís." The
    nudge follows the same rule.
12. **Warmth.** The readback ends with "¿Está bien así?" and a soft last line, "_También podés escribir:
    confirmar, corregir o cancelar._" (the plain "Respondé Confirmar, Corregir o Cancelar." when there are no
    buttons). A changed order opens with "Listo, así queda tu pedido:".
13. **Usted:** not done (skipped, as the brief said).

## Files

- New: `src/domain/small-talk.ts`, `src/domain/customer-name.ts`, `test/conversation-rules.test.ts` (32 tests:
  end to end through the Worker on both pretend engines, plus unit tests for each rule).
- Changed: `src/application/order-handler.ts`, `customer-gate.ts`, `engine.ts` (`answered`), `ports.ts`
  (`ButtonsShown`), `processor.ts`, `replies.ts`; `src/composition.ts`; `src/domain/replies.ts`, `copy.ts`,
  `customer-controls.ts`, `slow-notice.ts` (comment), `contract/outcomes.ts` (`what_to_order`, proposed);
  `src/infrastructure/memory/memory-engine.ts` (name hold, restating the step, `answered`; the snapshot gains an
  optional `held`, so state saved in D1 before this change still loads); `src/infrastructure/d1/outbox-repository.ts`
  (`D1ButtonsShown`).
- Tests changed to match the new wording and behavior (no guarantee dropped): `delivery-places`, `domain`,
  `first-contact`, `order-flow`, `replies` (+1 test), `reply-dispatch`, `slow-notice`, `customer-controls`,
  `intake`, `helpers/harness`.
- Docs: `docs/contract.md` "Proposed (conversation rules)", `docs/architecture.md` (the replies section),
  `docs/status.md`.

## Results

- `npm run typecheck`: exit 0, no errors.
- `npm test`: `Test Files  42 passed (42)`, `Tests  573 passed (573)`.
- `npx wrangler types --check`: `✨ Types at worker-configuration.d.ts are up to date.`

## Simulator transcripts

Local simulator on :8787 with the real Muse Spark reading and the demo store. Input was piped into `npm run chat`
with 25 s pauses (45 s for B), and ANSI codes were stripped. The chat doesn't echo piped input, so the customer
lines are added back here.

### A. Name at the end, Confirmar tapped first (typing "1" taps the first button)

```
Vos: Hola
Tienda: ¡Buenas! 👋 Soy el asistente de *Tienda demo (sintética)* 🛒
        Te tomo el pedido y te aviso cuando esté listo. ¿Qué te mando?
        _Si no querés recibir mensajes, escribí ALTO._
        [1] 🕘 Horario   [2] ✋ Hablar con alguien
Vos: mandame 2 libras de arroz y una leche
Tienda: ¿Lo recogés en la tienda o te lo llevamos?
Vos: lo paso a traer
Tienda: Tu pedido:
        1. Arroz 1 lb: 2 libras × L 18 = L 36
        2. Leche entera 1 L: 1 × L 32 = L 32
        Lo recogés en la tienda.
        Total: L 68
        ¿Está bien así?
        _También podés escribir: confirmar, corregir o cancelar._
        [1] Confirmar   [2] Corregir   [3] Cancelar
Vos: 1   (tocaste Confirmar)
Tienda: ¡Va! ¿A nombre de quién lo anoto?
Vos: sí
Tienda: ¿Me decís tu nombre para anotar el pedido? 🙏
Vos: Carla
Tienda: Listo, Carla, tu pedido ya está en la lista de preparación. Te aviso cuando esté listo.
```

### B. "sí" typed to confirm (name given with the greeting)

```
Vos: Hola, soy Marta
Tienda: ¡Buenas! 👋 Soy el asistente de *Tienda demo (sintética)* 🛒
        Te tomo el pedido y te aviso cuando esté listo. ¿Qué te mando?
        _Si no querés recibir mensajes, escribí ALTO._
        [1] 🕘 Horario   [2] ✋ Hablar con alguien
Vos: quiero 3 libras de azúcar
Tienda: ¿Lo recogés en la tienda o te lo llevamos?
Vos: paso por él
Tienda: Tu pedido:
        1. Azúcar 1 lb: 3 libras × L 16 = L 48
        Lo recogés en la tienda.
        Total: L 48
        ¿Está bien así?
        _También podés escribir: confirmar, corregir o cancelar._
        [1] Confirmar   [2] Corregir   [3] Cancelar
Vos: sí
Tienda: Listo, Marta, tu pedido ya está en la lista de preparación. Te aviso cuando esté listo.
```

An earlier run with 25 s pauses showed the safety rule working. The model took about 38 s on "paso por él", so the
"sí" arrived before the readback was queued. It didn't confirm anything; it was read with that burst, and the
readback went out.

### C. hola and gracias mid-order

```
Vos: 2 libras de arroz
Tienda: ¡Buenas! 👋 Soy el asistente de *Tienda demo (sintética)* 🛒
        ¿Lo recogés en la tienda o te lo llevamos?
        _Si no querés recibir mensajes, escribí ALTO._
Vos: hola
Tienda: ¡Buenas! 👋
        ¿Lo recogés en la tienda o te lo llevamos?
Vos: lo recojo
Tienda: Tu pedido:
        1. Arroz 1 lb: 2 libras × L 18 = L 36
        Lo recogés en la tienda.
        Total: L 36
        ¿Está bien así?
        _También podés escribir: confirmar, corregir o cancelar._
        [1] Confirmar   [2] Corregir   [3] Cancelar
Vos: gracias
Tienda: Para dejarlo listo, tocá Confirmar ✅
        [1] Confirmar   [2] Corregir   [3] Cancelar
Vos: 1   (tocaste Confirmar)
Tienda: ¡Va! ¿A nombre de quién lo anoto?
Vos: Pedro
Tienda: Listo, Pedro, tu pedido ya está en la lista de preparación. Te aviso cuando esté listo.
```

### D. Question and order together, then "dale"

```
Vos: ¿A cómo está la leche? y mandame 2 libras de arroz
Tienda: ¡Buenas! 👋 Soy el asistente de *Tienda demo (sintética)* 🛒
        Leche: L 32.
        ¿Lo recogés en la tienda o te lo llevamos?
        _Si no querés recibir mensajes, escribí ALTO._
Vos: lo recojo
Tienda: Tu pedido:
        1. Arroz 1 lb: 2 libras × L 18 = L 36
        Lo recogés en la tienda.
        Total: L 36
        ¿Está bien así?
        _También podés escribir: confirmar, corregir o cancelar._
        [1] Confirmar   [2] Corregir   [3] Cancelar
Vos: dale
Tienda: ¡Va! ¿A nombre de quién lo anoto?
Vos: Luis
Tienda: Listo, Luis, tu pedido ya está en la lista de preparación. Te aviso cuando esté listo.
```

## Decisions for Angel

1. **The name is asked at most twice per order.** After a second answer that isn't a name, the order is confirmed
   without one, so the order never gets stuck on the name. A customer who was asked on an earlier order and gave
   no name isn't asked again: Confirmar confirms at once.
2. **The confirmation uses the customer's name** when we have it ("Listo, Carla, …"). This is new copy.
3. **A typed yes counts only when the last message had that version's Confirmar button.** After any other message
   (a question, an answer) the yes is read normally, because it may answer that message instead. A "sí" sent
   before the readback arrived never confirms (see run B).
4. **A greeting, thanks or "ok" makes no model call.** A yes word while a question is waiting is still read,
   because it may answer the question.
5. **A second tap of an answered button gets a reply.** The readback buttons get "¡A la orden! 🙌"; Sí / Otro lugar
   gets the Confirmar nudge with buttons. Before this change those taps got no reply at all.
6. **Kept as is:** the safe reply "Dejame revisar bien y ya te confirmo." ("ya" is a mild time hint; tell me if it
   should go too).

## Not done, risks, open

- Item 13 (usted) is not done.
- Engine side: the name hold, restating the step, `answered`, and `what_to_order` exist only in the pretend
  engine. kercmari's engine (PR #62) needs them; they are written up as proposals in contract.md "Proposed
  (conversation rules)", and #47 point 5 is superseded there.
- `nameFrom` folds repeated letters the same way catalog names are folded ("Arroz" becomes "aroz"), so the
  product check works only because both sides fold. It's covered by a test.
- Trap: editing source while the simulator runs hot-reloads it, and the in-memory pretend engine loses its open
  orders. Two first-try transcripts were spoiled this way and were rerun.

## Next step

Angel reads the transcripts and the decisions, then commits (or asks for changes). After that, raise the
contract proposal with kercmari for PR #62.
