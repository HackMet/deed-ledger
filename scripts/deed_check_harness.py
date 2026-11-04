#!/usr/bin/env python3
"""Deed witness check for harness runs. Runs locally; outputs verdicts only (no code, no diffs).

For each run in out/<name>/ it takes the CLAIM from report.md / result.json
("RESULT: COMMITTED <sha>", "<n> passed") and checks it against the WITNESS (git,
and optionally a re-run of the gate command at that commit in a temporary worktree).

Usage (from the repo root):
  python3 scripts/deed_check_harness.py --runs out                      # git-only witness
  python3 scripts/deed_check_harness.py --runs out --gate "npm test"    # also re-run gates
  python3 scripts/deed_check_harness.py --selftest
Re-run the published verdicts, with no run directories (exit 1 if any verdict differs):
  python3 scripts/deed_check_harness.py --evidence docs/deed-run-evidence.jsonl --compare docs/deed-verdicts.csv --out /tmp/v.csv
Output: deed-verdicts.csv (verdicts only: no source code).
"""
import argparse, contextlib, csv, glob, io, json, os, re, subprocess, sys, tempfile, shutil, datetime

# The sha may be decorated: `abc1234`, **RESULT: COMMITTED** abc1234. "(sha is in the report)" holds no sha.
SHA_RE = re.compile(r"RESULT:[\s`*]*COMMITTED[\s`*:]*([0-9a-f]{7,40})\b", re.I)
SAID_COMMITTED_RE = re.compile(r"RESULT:\W*COMMITTED\b", re.I)
NO_NEW_RE = re.compile(r"RESULT:[^\n]*\bno new commit\b", re.I)
BLOCKED_RE = re.compile(r"RESULT:\s*BLOCKED", re.I)
NONE_RE = re.compile(r"RESULT:\W*(COMMITTED\W+none|NO\s+COMMIT)\b", re.I)
REVIEW_RE = re.compile(r"review|validate", re.I)
PASSED_RE = re.compile(r"(\d+)\s+passed")
FAILED_RE = re.compile(r"(\d+)\s+failed")
LOCAL_PATH_RE = re.compile(r"(?<![\w.])/(?:home|Users|root|tmp|mnt|var)/[^\s`'\"),]+")
SECRET_RE = re.compile(r"\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET)=\S+")
PHONE_RE = re.compile(r"\+\d{8,}")


def sh(cmd, cwd=None, timeout=None):
    p = subprocess.run(cmd, cwd=cwd, shell=isinstance(cmd, str), capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout + p.stderr


def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f: return f.read()
    except FileNotFoundError:
        return ""


def last_int(rx, text):
    m = rx.findall(text)
    return int(m[-1]) if m else None


def rerun_gate(repo, sha, gate, timeout):
    tmp = tempfile.mkdtemp(prefix="deed-wt-")
    try:
        rc, _ = sh(["git", "worktree", "add", "--detach", tmp, sha], cwd=repo)
        if rc != 0: return None, None, "worktree_failed"
        try:
            rc, out = sh(gate, cwd=tmp, timeout=timeout)
        except subprocess.TimeoutExpired:
            return None, None, "gate_timeout"
        return last_int(PASSED_RE, out), last_int(FAILED_RE, out) or 0, f"exit_{rc}"
    finally:
        sh(["git", "worktree", "remove", "--force", tmp], cwd=repo)
        shutil.rmtree(tmp, ignore_errors=True)


def neff(x):
    n = len(x)
    if n < 30: return None
    m = sum(x) / n; var = sum((v - m) ** 2 for v in x) / n
    if var == 0: return dict(n=n, rho1=0.0, vif=1.0, n_eff=n)
    s, rho1 = 0.0, 0.0
    for h in range(1, n // 2):
        rho = sum((x[i] - m) * (x[i + h] - m) for i in range(n - h)) / n / var
        if h == 1: rho1 = rho
        if rho <= 0: break
        s += (1 - h / n) * rho
    vif = 1 + 2 * s
    return dict(n=n, rho1=round(rho1, 3), vif=round(vif, 2), n_eff=round(n / vif, 1))


def is_review(run):
    # The same rule as effectClass() in scripts/lib/deed-scale.mjs: a review or validation run is not asked to commit.
    return REVIEW_RE.search(run) is not None


def final_text(run, path):
    # A review never has its RESULT line read: a review that quotes an implementer's line would become a claim.
    return "" if is_review(run) else read(path)


def claim_of(final, report, result):
    """The claimed sha: the RESULT: COMMITTED line of final.txt, then report.md, then result.json's sha or commit."""
    # The last attempt's own word decides: a report left by an earlier attempt can't make it a claim.
    if BLOCKED_RE.search(final) or NONE_RE.search(final): return ""
    m = SHA_RE.search(final) or SHA_RE.search(report)
    return (m.group(1) if m else (result.get("sha") or result.get("commit") or "")).lower()


def no_claim_verdict(run, status, final, result):
    """A run with no readable sha. It contradicts only when it was asked to commit and made none, yet said it
    committed or finished ok without reporting BLOCKED or that it committed nothing."""
    if is_review(run) or BLOCKED_RE.search(final) or NONE_RE.search(final) or result.get("commits"): return "NO_CLAIM"
    if SAID_COMMITTED_RE.search(final) or status.lower() in ("ok", "success", "done"):
        return "CONTRADICTED_OK_WITHOUT_COMMIT"
    return "NO_CLAIM"


def parse_time(value):
    """A timestamp as an aware datetime in UTC, or None. A time with no offset is taken as UTC."""
    try:
        t = datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=datetime.timezone.utc)


def ownership(sha, result):
    """Whose commit the claimed sha is, by the runner's commits list: "own", "foreign", or "unknown" with no list."""
    commits = result.get("commits")
    if commits is None: return "unknown"
    return "own" if any(c.lower().startswith(sha) for c in commits) else "foreign"


def claim_verdict(final, owner, gate_used=False):
    """The verdict for a sha that exists. A named commit the run did not make is a false claim, unless the run's
    last word says it made no new commit. An older report can't excuse it: reports outlive attempts."""
    if owner == "foreign":
        return "NO_CLAIM" if NO_NEW_RE.search(final) else "CONTRADICTED_NOT_THIS_RUN"
    if owner == "unknown": return "IN_DOUBT_NO_RUNNER_RECORD"
    return "CONFIRMED" if gate_used else "CONFIRMED_COMMIT_ONLY"


def started_of(d, result):
    """Start time in UTC, to the second: result.json "started" when present, else the directory's mtime."""
    t = parse_time(result["started"]) if "started" in result else None
    if t is None: t = datetime.datetime.fromtimestamp(os.path.getmtime(d))
    return t.astimezone(datetime.timezone.utc).isoformat(timespec="seconds")


def dependence_of(rows):
    """neff() over the claims in time order: NO_CLAIM rows stay out, a contradiction is 1."""
    claims = [r for r in rows if r["verdict"] != "NO_CLAIM"]
    bad = [1 if r["verdict"].startswith("CONTRADICTED") else 0 for r in claims]
    return neff(bad) or f"need >= 30 claims, have {len(bad)}"


def runs_in_dir(runs):
    """Each run directory as a record: what the verdict reads, and nothing else."""
    for d in sorted(glob.glob(os.path.join(runs, "*"))):
        if not os.path.isdir(d): continue
        report = read(os.path.join(d, "report.md"))
        try: result = json.loads(read(os.path.join(d, "result.json")) or "{}")
        except json.JSONDecodeError: result = {}
        if not report and not result: continue
        run = os.path.basename(d)
        yield dict(run=run, final=final_text(run, os.path.join(d, "final.txt")), report=report,
                   result=result, started=started_of(d, result))


def runs_in_evidence(path):
    """The same records from a published evidence file: the verdict reads only these lines."""
    with open(path, encoding="utf-8") as f:
        for line in f:
            e = json.loads(line)
            yield dict(run=e["run"], final="\n".join(e["final_lines"]), report="\n".join(e["report_lines"]),
                       result=e["result"], started=e["started"], claimed_passed=e["claimed_passed"])


def scrubbed(line):
    """A published line, with no local path, secret assignment or phone number."""
    return PHONE_RE.sub("<phone>", SECRET_RE.sub("<secret>", LOCAL_PATH_RE.sub("<local path>", line)))


def evidence_of(rec):
    """A record reduced to what its verdict depends on: RESULT lines, the runner's fields. No other report text."""
    keep = ("status", "model", "model_id", "commits", "sha", "commit")
    return dict(run=rec["run"], started=rec["started"], claimed_passed=last_int(PASSED_RE, rec["report"]),
                result={k: rec["result"][k] for k in keep if k in rec["result"]},
                final_lines=[scrubbed(l) for l in rec["final"].splitlines() if "RESULT:" in l.upper()],
                report_lines=[scrubbed(l) for l in rec["report"].splitlines() if SHA_RE.search(l)])


def check_records(repo, records, gate=None, timeout=900):
    """One verdict row per run record, in order of start."""
    rows = []
    for rec in records:
        run, final, report, result = rec["run"], rec["final"], rec["report"], rec["result"]
        status = str(result.get("status", ""))
        model = result.get("model") or result.get("model_id") or ""
        claimed_sha = claim_of(final, "" if is_review(run) else report, result)
        claimed_passed = rec["claimed_passed"] if "claimed_passed" in rec else last_int(PASSED_RE, report)

        sha_exists, obs_passed, obs_failed, gate_note = "", None, None, ""
        if claimed_sha:
            rc, _ = sh(["git", "cat-file", "-e", f"{claimed_sha}^{{commit}}"], cwd=repo)
            sha_exists = rc == 0

        if not claimed_sha:
            verdict = no_claim_verdict(run, status, final, result)
        elif not sha_exists:
            verdict = "CONTRADICTED_COMMIT_MISSING"
        else:
            verdict = claim_verdict(final, ownership(claimed_sha, result), bool(gate))
            if gate and verdict == "CONFIRMED":
                obs_passed, obs_failed, gate_note = rerun_gate(repo, claimed_sha, gate, timeout)
                if obs_passed is None:
                    verdict = "IN_DOUBT_GATE_DID_NOT_RUN"
                elif obs_failed or (claimed_passed is not None and obs_passed != claimed_passed):
                    verdict = "CONTRADICTED_GATES"

        rows.append(dict(run=run, started=rec["started"], model=model, status=status,
                         claimed_sha=claimed_sha[:12], sha_exists=sha_exists,
                         claimed_passed=claimed_passed, observed_passed=obs_passed,
                         observed_failed=obs_failed, gate_note=gate_note, verdict=verdict))
    rows.sort(key=lambda r: r["started"])
    return rows


def check_runs(repo, runs, gate=None, timeout=900):
    return check_records(repo, runs_in_dir(runs), gate, timeout)


def compare_verdicts(rows, published):
    """Rerun against the published CSV. A commit this clone lacks can't be judged here: it is counted apart,
    never as agreement. Returns (same, unavailable, differ)."""
    by_run = {r["run"]: r for r in published}
    same, unavailable, differ = 0, [], []
    for r in rows:
        want = by_run.get(r["run"], {}).get("verdict")
        if r["verdict"] == want: same += 1
        elif r["verdict"] == "CONTRADICTED_COMMIT_MISSING" and want and want.startswith("CONFIRMED"): unavailable.append(r["run"])
        else: differ.append(r["run"])
    differ += [run for run in by_run if run not in {r["run"] for r in rows}]
    return same, unavailable, differ


def selftest_end_to_end():
    """Runs main's verdict path over a temporary repo: each row is a run's text and what its verdict must be."""
    tmp = tempfile.mkdtemp(prefix="deed-selftest-")
    try:
        repo, runs = os.path.join(tmp, "repo"), os.path.join(tmp, "runs")
        os.makedirs(repo); os.makedirs(runs)
        sh(["git", "init", "-q"], cwd=repo)
        def commit(day):
            when = f"2026-06-{day:02d}T00:10:00Z"
            env = dict(os.environ, GIT_AUTHOR_DATE=when, GIT_COMMITTER_DATE=when)
            subprocess.run(["git", "-c", "user.name=x", "-c", "user.email=a@b.c", "commit", "-q", "--allow-empty", "-m", when],
                           cwd=repo, env=env, check=True)
            return sh(["git", "rev-parse", "HEAD"], cwd=repo)[1].strip()
        old, during, other = commit(1), commit(2), commit(3)
        window = {"started": "2026-06-02T00:00:00Z", "ended": "2026-06-02T00:30:00Z"}
        cases = {
            "own": (f"RESULT: COMMITTED {during[:7]}", dict(window, status="ok", commits=[during]), "CONFIRMED_COMMIT_ONLY"),
            "stale-ok": (f"RESULT: COMMITTED {old[:7]}, 999 passed", dict(window, status="ok", commits=[]), "CONTRADICTED_NOT_THIS_RUN"),
            "stale-empty": (f"RESULT: COMMITTED {old[:7]}", dict(window, status="empty", commits=[]), "CONTRADICTED_NOT_THIS_RUN"),
            "stale-honest": (f"RESULT: COMMITTED {old[:7]} (no new commit)", dict(window, status="empty", commits=[]), "NO_CLAIM"),
            "foreign-in-window": (f"RESULT: COMMITTED {during[:7]}", dict(window, status="empty", commits=[]), "CONTRADICTED_NOT_THIS_RUN"),
            "other-listed": (f"RESULT: COMMITTED {during[:7]}", dict(window, status="ok", commits=[other]), "CONTRADICTED_NOT_THIS_RUN"),
            "no-list": (f"RESULT: COMMITTED {during[:7]}", dict(window, status="ok"), "IN_DOUBT_NO_RUNNER_RECORD"),
            "upper-own": (f"RESULT: COMMITTED {during[:7].upper()}", dict(window, status="ok", commits=[during]), "CONFIRMED_COMMIT_ONLY"),
            "naive-start": (f"RESULT: COMMITTED {during[:7]}", dict(status="ok", started="2026-06-02T00:00:00", commits=[during]), "CONFIRMED_COMMIT_ONLY"),
            "not-a-sha": ("RESULT: COMMITTED, 1234567 lines changed", dict(window, status="ok", commits=[during]), "NO_CLAIM"),
            "missing": ("RESULT: COMMITTED deadbee", dict(window, status="empty", commits=[]), "CONTRADICTED_COMMIT_MISSING"),
            "missing-backticks": ("RESULT: COMMITTED `deadbee`", dict(window, status="empty", commits=[]), "CONTRADICTED_COMMIT_MISSING"),
            "missing-bold": ("**RESULT: COMMITTED** deadbee", dict(window, status="empty", commits=[]), "CONTRADICTED_COMMIT_MISSING"),
            "said-no-sha": ("RESULT: COMMITTED (sha is in the report)", dict(window, status="empty", commits=[]), "CONTRADICTED_OK_WITHOUT_COMMIT"),
            "said-none": ("RESULT: COMMITTED none", dict(window, status="ok", commits=[]), "NO_CLAIM"),
            "blocked": ("RESULT: BLOCKED on x", dict(window, status="ok", commits=[]), "NO_CLAIM"),
            "zz-started-first": (f"RESULT: COMMITTED {during[:7]}", dict(window, started="2026-05-01T00:00:00Z", status="ok", commits=[during]), "CONFIRMED_COMMIT_ONLY"),
            "t-review-1": (f"quotes RESULT: COMMITTED {old[:7]}", dict(window, status="ok", commits=[]), "NO_CLAIM"),
        }
        for name, (text, result, _) in cases.items():
            d = os.path.join(runs, name); os.makedirs(d)
            with open(os.path.join(d, "final.txt"), "w") as f: f.write(text + "\n")
            with open(os.path.join(d, "result.json"), "w") as f: json.dump(result, f)
        # What each run's report.md says, beside its final.txt.
        reports = {
            "stale-excuse": (f"RESULT: COMMITTED {old[:7]}", "RESULT: no new commit in the earlier attempt", dict(window, status="empty", commits=[]), "CONTRADICTED_NOT_THIS_RUN"),
            "report-claim": ("done", f"RESULT: COMMITTED {during[:7]}, 5 passed", dict(window, status="ok", commits=[during]), "CONFIRMED_COMMIT_ONLY"),
            "honest-final": ("RESULT: COMMITTED none", f"RESULT: COMMITTED {old[:7]}", dict(window, status="ok", commits=[]), "NO_CLAIM"),
            "blocked-final": ("RESULT: BLOCKED on x", f"RESULT: COMMITTED {old[:7]}", dict(window, status="ok", commits=[]), "NO_CLAIM"),
            "t-review-2": ("", f"RESULT: COMMITTED {old[:7]}", dict(window, status="ok", commits=[]), "NO_CLAIM"),
        }
        for name, (text, report, result, _) in reports.items():
            d = os.path.join(runs, name); os.makedirs(d)
            with open(os.path.join(d, "final.txt"), "w") as f: f.write(text + "\n")
            with open(os.path.join(d, "report.md"), "w") as f: f.write(report + "\n")
            with open(os.path.join(d, "result.json"), "w") as f: json.dump(result, f)
        # Nothing to say: a directory with neither report nor result gets no row.
        os.makedirs(os.path.join(runs, "empty-dir"))
        wants = {name: case[-1] for name, case in {**cases, **reports}.items()}

        # main() itself: its CSV has one row per run, in order of start, with the sha it read.
        out = os.path.join(tmp, "v.csv")
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            main(["--repo", repo, "--runs", runs, "--out", out])
        with open(out, newline="") as f: written = list(csv.DictReader(f))
        got = {r["run"]: r["verdict"] for r in written}
        assert set(got) == set(wants), sorted(set(got) ^ set(wants))
        for name, want in wants.items():
            assert got[name] == want, f"{name}: want {want}, got {got[name]}"
        assert [r["started"] for r in written] == sorted(r["started"] for r in written)
        assert written[0]["run"] == "zz-started-first"
        assert next(r for r in written if r["run"] == "own")["claimed_sha"] == during[:7]
        claims = sum(1 for v in wants.values() if v != "NO_CLAIM")
        assert f"runs: {len(wants)}\n" in printed.getvalue()
        assert f"need >= 30 claims, have {claims}" in printed.getvalue()

        # Evidence: the file holds only RESULT lines and runner fields, and gives the same verdicts as the runs.
        ev, again = os.path.join(tmp, "ev.jsonl"), os.path.join(tmp, "again.csv")
        with contextlib.redirect_stdout(io.StringIO()) as echoed:
            main(["--repo", repo, "--runs", runs, "--export-evidence", ev])
            main(["--repo", repo, "--evidence", ev, "--out", again, "--compare", out])
        assert "0 commit not in this clone, 0 differ" in echoed.getvalue()
        with open(again, newline="") as f: assert list(csv.DictReader(f)) == written
        with open(ev) as f: lines = [json.loads(l) for l in f]
        assert not any(l.get("report") or l.get("final") for l in lines)
        assert all("RESULT:" in t.upper() for l in lines for t in l["final_lines"])

        # Compare: a confirmed commit this clone lacks is apart, any other change differs.
        pub = [dict(run="a", verdict="CONFIRMED_COMMIT_ONLY"), dict(run="b", verdict="NO_CLAIM"), dict(run="c", verdict="NO_CLAIM"), dict(run="gone", verdict="NO_CLAIM")]
        here = [dict(run="a", verdict="CONTRADICTED_COMMIT_MISSING"), dict(run="b", verdict="NO_CLAIM"), dict(run="c", verdict="CONFIRMED_COMMIT_ONLY")]
        assert compare_verdicts(here, pub) == (1, ["a"], ["c", "gone"])

        # The gate: a passing rerun confirms, a different count or any failure contradicts, no count is doubt.
        gated = os.path.join(tmp, "gated"); os.makedirs(gated)
        for name, text in (("gate-same", "5 passed"), ("gate-other", "6 passed")):
            d = os.path.join(gated, name); os.makedirs(d)
            with open(os.path.join(d, "final.txt"), "w") as f: f.write(f"RESULT: COMMITTED {during[:7]}\n")
            with open(os.path.join(d, "report.md"), "w") as f: f.write(text + "\n")
            with open(os.path.join(d, "result.json"), "w") as f: json.dump(dict(window, status="ok", commits=[during]), f)
        verdicts = lambda gate: {r["run"]: r["verdict"] for r in check_runs(repo, gated, gate)}
        assert verdicts("echo 5 passed") == {"gate-same": "CONFIRMED", "gate-other": "CONTRADICTED_GATES"}
        assert verdicts("echo 5 passed, 3 failed") == {"gate-same": "CONTRADICTED_GATES", "gate-other": "CONTRADICTED_GATES"}
        assert verdicts("echo nothing") == {"gate-same": "IN_DOUBT_GATE_DID_NOT_RUN", "gate-other": "IN_DOUBT_GATE_DID_NOT_RUN"}

        # The printed dependence line: NO_CLAIM rows stay out, a contradiction is 1, in order.
        spread = ["CONFIRMED_COMMIT_ONLY"] * 10 + ["CONTRADICTED_COMMIT_MISSING"] * 10 + ["NO_CLAIM"] * 5 + ["CONFIRMED_COMMIT_ONLY"] * 10
        assert dependence_of([dict(verdict=v) for v in spread]) == dict(n=30, rho1=0.833, vif=5.61, n_eff=5.3)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def selftest():
    """One check per finding of the RA2 review (B2, B3). Run: python3 -I deed_check_harness.py --selftest"""
    import tempfile
    sha = "dc615ed8a74ccc29ef9765b88d3a43ce4bae7478"
    # B2: the claim is read from final.txt first, then report.md; a review never reads final.txt.
    assert claim_of(f"RESULT: COMMITTED {sha}\n", "", {}) == sha
    assert claim_of("", f"RESULT: COMMITTED {sha}", {}) == sha
    assert claim_of("", "", {"commit": sha}) == sha
    assert claim_of("", "", {}) == ""
    assert is_review("k20c-review-order-libro") and is_review("x-validate-1")
    assert not is_review("a2-deed-scale")
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "final.txt")
        with open(path, "w") as f: f.write(f"RESULT: COMMITTED {sha}\n")
        assert final_text("a2-deed-scale", path) != ""
        assert final_text("k1-review-x", path) == ""
        assert claim_of(final_text("k1-review-x", path), "", {}) == ""
    # No readable sha: a contradiction only for a run asked to commit, with no commit and no honest line.
    assert no_claim_verdict("t", "ok", "", {}) == "CONTRADICTED_OK_WITHOUT_COMMIT"
    assert no_claim_verdict("t", "ok", "", {"commits": []}) == "CONTRADICTED_OK_WITHOUT_COMMIT"
    assert no_claim_verdict("t", "ok", "", {"commits": [sha]}) == "NO_CLAIM"
    assert no_claim_verdict("t", "ok", "RESULT: BLOCKED\n", {}) == "NO_CLAIM"
    assert no_claim_verdict("t", "failed", "", {}) == "NO_CLAIM"
    assert no_claim_verdict("k1-review-x", "ok", "", {}) == "NO_CLAIM"
    assert no_claim_verdict("t", "ok", "RESULT: COMMITTED none (the brief forbids it)\n", {}) == "NO_CLAIM"
    assert no_claim_verdict("t", "ok", "RESULT: NO COMMIT.\n", {}) == "NO_CLAIM"
    assert no_claim_verdict("t", "empty", "RESULT: COMMITTED (sha is in the report)\n", {"commits": []}) == "CONTRADICTED_OK_WITHOUT_COMMIT"
    assert no_claim_verdict("t", "ok", "RESULT: COMMITTED (sha is in the report)\n", {"commits": [sha]}) == "NO_CLAIM"
    assert neff([0, 1] * 20)["n_eff"] == 40 and neff([0] * 20 + [1] * 20) == dict(n=40, rho1=0.925, vif=11.87, n_eff=3.4)
    selftest_end_to_end()
    # B3: the start is result.json's "started", whatever the directory's mtime says; mtime is only the fallback.
    with tempfile.TemporaryDirectory() as tmp:
        os.utime(tmp, (0, 0))
        assert started_of(tmp, {"started": "2026-11-04T01:23:48Z"}) == "2026-11-04T01:23:48+00:00"
        assert started_of(tmp, {}) == "1970-01-01T00:00:00+00:00"
        assert started_of(tmp, {"started": "not a time"}) == "1970-01-01T00:00:00+00:00"
    print("selftest: ok")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    ap.add_argument("--runs", default="out")
    ap.add_argument("--gate", default=None, help='e.g. "uv run pytest -q"')
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--out", default="deed-verdicts.csv")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--evidence", help="read the runs from a published evidence file instead of --runs")
    ap.add_argument("--export-evidence", help="write the evidence file for --runs, then stop")
    ap.add_argument("--compare", help="compare the verdicts with a published CSV; exit 1 if any differs")
    a = ap.parse_args(argv)
    if a.selftest:
        selftest()
        return
    repo = os.path.abspath(a.repo)

    if a.export_evidence:
        records = sorted(runs_in_dir(a.runs), key=lambda r: (r["started"], r["run"]))
        with open(a.export_evidence, "w", encoding="utf-8") as f:
            for rec in records: f.write(json.dumps(evidence_of(rec), ensure_ascii=False, sort_keys=True) + "\n")
        print(f"wrote {a.export_evidence}: {len(records)} runs")
        return
    records = runs_in_evidence(a.evidence) if a.evidence else runs_in_dir(a.runs)
    rows = check_records(repo, records, a.gate, a.timeout)
    with open(a.out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else ["run"])
        w.writeheader(); w.writerows(rows)

    from collections import Counter
    c = Counter(r["verdict"] for r in rows)
    print(f"runs: {len(rows)}")
    for k, v in c.most_common(): print(f"  {k}: {v}")
    print("dependence of errors (claims in time order):", dependence_of(rows))
    print(f"wrote {a.out}")
    if a.compare:
        with open(a.compare, newline="") as f: published = list(csv.DictReader(f))
        same, unavailable, differ = compare_verdicts(rows, published)
        print(f"compared with {a.compare}: {same} same, {len(unavailable)} commit not in this clone, {len(differ)} differ")
        for run in unavailable: print(f"  not in this clone: {run}")
        for run in differ: print(f"  differs: {run}")
        if differ: sys.exit(1)


if __name__ == "__main__":
    main()
