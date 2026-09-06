import { useEffect, useState } from "react";
import { store, useActiveSession, useUi } from "../store.js";
import type { QuestionAnswers, QuestionView } from "../types.js";

const KIND_LABEL: Record<string, string> = {
  answer_question: "question",
  choose_candidate: "choose a candidate (Triage board)",
  state_hypothesis: "state your hypothesis",
  locate_line: "find the line yourself",
  state_fix: "state what the fix is",
  write_test: "write the failing test",
  draft_pr_description: "draft the PR description",
  explain_back: "explain it back",
  confirm_go_ahead: "go-ahead needed",
  confirm_resume: "confirm how to resume",
  other: "your turn",
};

/**
 * The agent's clarifying questions (Claude Code's AskUserQuestion tool),
 * rendered as options. The agent is blocked until this is submitted; all
 * questions in one call are answered together.
 */
function QuestionCard({ q }: { q: QuestionView }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const toggle = (question: string, label: string, multi: boolean) =>
    setPicked((p) => {
      const cur = p[question] ?? [];
      if (multi) return { ...p, [question]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
      return { ...p, [question]: [label] };
    });

  const answered = q.questions.every((x) => (picked[x.question]?.length ?? 0) > 0 || (other[x.question] ?? "").trim());

  const submit = () => {
    const answers: QuestionAnswers = {};
    for (const x of q.questions) {
      const free = (other[x.question] ?? "").trim();
      const sel = picked[x.question] ?? [];
      if (free) answers[x.question] = x.multiSelect && sel.length ? [...sel, free] : free;
      else answers[x.question] = x.multiSelect ? sel : sel[0] ?? "";
    }
    setBusy(true);
    store.answerQuestion(q.id, answers);
  };

  return (
    <div className="yt-item yt-question">
      <div className="qc-head">
        <span className="qc-badge"><span className="leaves sm"><i /><i /><i /></span> the agent asks</span>
        <span className="faint">{q.questions.length === 1 ? "one question" : `${q.questions.length} questions`} · the agent waits for this</span>
      </div>
      {q.questions.map((x, qi) => (
        <div key={x.question} className="qc-q">
          <div className="qc-title">
            {q.questions.length > 1 && <span className="qc-n">{qi + 1}</span>}
            <span className="tag accent">{x.header}</span>
            <b>{x.question}</b>
          </div>
          <div className="qc-options" role={x.multiSelect ? "group" : "radiogroup"}>
            {x.options.map((o) => {
              const on = (picked[x.question] ?? []).includes(o.label);
              return (
                <label key={o.label} className={`qc-opt${on ? " on" : ""}`}>
                  <input type={x.multiSelect ? "checkbox" : "radio"} name={q.id + x.question} checked={on} onChange={() => toggle(x.question, o.label, x.multiSelect)} />
                  <span className="qc-mark" aria-hidden="true">{on ? "✓" : ""}</span>
                  <span className="qc-text">
                    <b>{o.label}</b>
                    {o.description && <span className="muted">{o.description}</span>}
                  </span>
                </label>
              );
            })}
          </div>
          <input className="qc-other" type="text" value={other[x.question] ?? ""} onChange={(e) => setOther((s) => ({ ...s, [x.question]: e.target.value }))} placeholder={x.multiSelect ? "add your own answer (optional)" : "or type your own answer"} />
        </div>
      ))}
      <button className="btn primary qc-send" disabled={busy || !answered} onClick={submit}>{busy ? "Sending…" : answered ? "Send answers" : "Choose an answer for each question"}</button>
    </div>
  );
}

/**
 * The "How This Splits Between Us" queue. Items come from the agent's
 * structured output, never from parsing prose. When several items are
 * pending, answers go out as ONE message so the agent sees them together.
 */
export function YourTurnPanel() {
  const s = useActiveSession();
  const questions = useUi((st) => st.questions);
  const items = s?.lastState?.your_turn_items ?? [];
  const myQuestions = s ? questions.filter((q) => q.sessionId === s.id) : [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // A new state list means the previous answers were consumed.
  useEffect(() => {
    setAnswered(new Set());
  }, [s?.id, JSON.stringify(items.map((i) => i.id))]);

  const open = items.filter((i) => !answered.has(i.id));
  const filled = open.filter((i) => (answers[i.id] ?? "").trim());

  const sendAll = async () => {
    if (!filled.length) return;
    setBusy(true);
    try {
      const text =
        filled.length === 1
          ? `Regarding "${filled[0].prompt}" (${KIND_LABEL[filled[0].kind] ?? filled[0].kind}):\n\n${answers[filled[0].id].trim()}`
          : `Answers to your ${filled.length} open items, together:\n\n` + filled.map((i, n) => `${n + 1}. Regarding "${i.prompt}" (${KIND_LABEL[i.kind] ?? i.kind}):\n   ${answers[i.id].trim()}`).join("\n\n") + (open.length > filled.length ? `\n\n(${open.length - filled.length} item(s) left unanswered for now.)` : "");
      await store.send(text);
      setAnswered((a) => {
        const n = new Set(a);
        for (const i of filled) n.add(i.id);
        return n;
      });
      setAnswers((a) => {
        const n = { ...a };
        for (const i of filled) delete n[i.id];
        return n;
      });
    } catch (e) {
      store.toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel stack">
      <h2>Your turn</h2>
      {!s && <div className="empty">No session.</div>}
      {myQuestions.map((q) => <QuestionCard key={q.id} q={q} />)}
      {s && items.length === 0 && myQuestions.length === 0 && <div className="empty">Nothing is waiting on you. The agent can proceed.</div>}
      {items.map((it) => {
        const done = answered.has(it.id);
        return (
          <div key={it.id} className={`yt-item${done ? " answered" : ""}`}>
            <div className="row">
              <span className="tag bloom">{KIND_LABEL[it.kind] ?? it.kind}</span>
              {it.blocks !== "none" && <span className="tag warn">locks {it.blocks}</span>}
              {done && <span className="tag">sent, awaiting agent</span>}
            </div>
            <div className="prompt">{it.prompt}</div>
            {!done && (
              <textarea
                value={answers[it.id] ?? ""}
                onChange={(e) => setAnswers((a) => ({ ...a, [it.id]: e.target.value }))}
                placeholder={it.kind === "confirm_go_ahead" ? "e.g. yes, go ahead / no, because…" : "Your answer, in your own words"}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") sendAll();
                }}
              />
            )}
          </div>
        );
      })}
      {open.length > 0 && (
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="faint">{open.length > 1 ? "All answers go in one message so the agent sees them together. " : ""}⌘/Ctrl+Enter to send</span>
          <button className="btn primary sm" disabled={busy || !filled.length} onClick={sendAll}>
            {open.length > 1 ? `Send ${filled.length} of ${open.length} answers` : "Submit"}
          </button>
        </div>
      )}
    </div>
  );
}
