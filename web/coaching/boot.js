/**
 * web/coaching/boot.js — coaching-report page bootstrap (task 4.4).
 *
 * External module only: the app CSP ships `script-src 'self'` with
 * `script-src-attr 'none'`, so the page cannot run inline script. This file
 * performs the auth gate, mounts the session / grader / report cards, then
 * swaps the loading note for the authenticated app shell.
 */
import { requireAuth } from "../auth.js";
import { mountSession } from "./session.js";
import { mountGrader } from "./grader.js";
import { mountReports } from "./report.js";
import { GWP_LOGO } from "../canvas/logo.js";

const $ = (id) => document.getElementById(id);

async function init() {
  $("brandMark").src = GWP_LOGO;
  const identity = await requireAuth();
  if (!identity) return; // redirected to /index.html

  const session = mountSession($("sessionCard"), {
    identity,
    onSession: () => grader?.refreshGradeState(),
  });

  const reports = mountReports($("reportDetailHost"), {
    identity,
    listEl: $("reportList"),
    emptyEl: $("reportListEmpty"),
    onRegrade: (sessionId, meta) => session.selectSession(sessionId, meta),
    // Label which of the user's sessions already carry a report.
    onListed: (items) => session.markReported(items.map((r) => r.sessionId)),
  });

  const grader = mountGrader($("graderCard"), {
    identity,
    getSessionId: () => session.currentSessionId(),
    onSaved: async (saved) => {
      await reports.refresh();
      await reports.open(saved.reportId);
    },
  });

  await session.ready;
  await reports.refresh();

  // Deep link: /coaching-report/?report=<id> opens the detail directly.
  const wanted = new URLSearchParams(location.search).get("report");
  if (wanted) await reports.open(wanted);

  $("loadNote").hidden = true;
  $("appMain").hidden = false;
}

init();
