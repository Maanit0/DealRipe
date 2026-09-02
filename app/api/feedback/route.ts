import { NextRequest, NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One rep, one click, from inside the artifact.
 *
 * GET because it has to work from Outlook, Gmail and a phone with no
 * JavaScript and no session. The token is the identity: a random uuid created
 * with the artifact and stored on its row, so there is nothing to log in to and
 * nothing to guess.
 *
 * NO AUTH, AND THAT IS THE POINT. The worst case is somebody with the token
 * rating an artifact they were sent. The alternative, a login before a rep can
 * say "this was useless", collects nothing.
 *
 * IDEMPOTENT AND CHANGEABLE. Clicking again overwrites: a rep who thumbs-down
 * then reconsiders should be able to say so, and a mail client that prefetches
 * links must not lock in a verdict nobody chose. That last risk is real, which
 * is why the reply page names what was recorded and offers the other option.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("id") ?? "";
  const vote = req.nextUrl.searchParams.get("v") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(token) || (vote !== "up" && vote !== "down")) {
    return page("That link looks wrong", "Nothing was recorded. If you meant to rate something, use the link at the foot of the email.");
  }

  try {
    const db = supabaseAdmin();
    const { data, error } = await db
      .from("sent_messages")
      .update({ feedback: vote, feedback_at: new Date().toISOString() })
      .eq("feedback_token", token)
      .select("kind, subject")
      .maybeSingle();

    if (error) {
      console.error(`[feedback] write failed for ${token.slice(0, 8)}: ${error.message}`);
      return page("We could not record that", "Something went wrong on our side. Nothing you did caused it, and it is worth telling Maanit.");
    }
    if (!data) {
      // A token we do not hold. Says so plainly rather than thanking someone
      // for a vote that went nowhere.
      return page("We could not find that", "The link may be from an older email. Nothing was recorded.");
    }

    console.log(`[feedback] ${vote} on ${data.kind} ("${String(data.subject).slice(0, 60)}")`);
    const other = vote === "up" ? "down" : "up";
    const otherLabel = vote === "up" ? "No, it was not" : "Actually, it was useful";
    // THE VOTE IS ALREADY SAVED. The box is optional and comes after, never
    // before: asking for a sentence in the email would cost the click, and a
    // click is the whole reason this collects anything. Whoever cares enough to
    // type gives us the half that is actually actionable.
    const prompt = vote === "up" ? "What worked?" : "What was wrong with it?";
    return page(
      "Noted, thank you",
      vote === "up"
        ? "Recorded as useful. It goes straight into what DealRipe writes you next."
        : "Recorded as not useful. That is the more valuable of the two, and it goes straight into what DealRipe writes you next.",
      `<form method="post" action="?id=${encodeURIComponent(token)}&v=${vote}" style="margin-top:18px">
  <label for="note" style="display:block;font-size:13px;color:#334155;margin-bottom:6px">${prompt} <span style="color:#94A3B8">Optional, one line is plenty.</span></label>
  <textarea id="note" name="note" rows="3" style="width:100%;box-sizing:border-box;font-family:inherit;font-size:14px;padding:9px 11px;border:1px solid #CBD5E1;border-radius:7px;resize:vertical"></textarea>
  <button type="submit" style="margin-top:9px;background:#0F172A;color:#fff;border:0;border-radius:7px;padding:9px 18px;font-size:14px;font-weight:600;cursor:pointer">Send</button>
</form>
<p style="margin-top:14px;font-size:13px;color:#6B7280">Changed your mind? <a href="?id=${encodeURIComponent(token)}&v=${other}" style="color:#2563EB">${otherLabel}</a>.</p>`,
    );
  } catch (err) {
    console.error(`[feedback] ${err instanceof Error ? err.message : String(err)}`);
    return page("We could not record that", "Something went wrong on our side.");
  }
}

function page(title: string, body: string, extra = ""): NextResponse {
  const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>${title}</title>
<div style="max-width:460px;margin:14vh auto;padding:0 20px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#0F172A">
  <div style="font-weight:700;font-size:15px;letter-spacing:-.2px">Deal<span style="color:#059669">Ripe</span></div>
  <h1 style="font-size:22px;margin:14px 0 8px;letter-spacing:-.3px">${title}</h1>
  <p style="font-size:14px;line-height:22px;color:#334155;margin:0">${body}</p>
  ${extra}
</div>`;
  return new NextResponse(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

/**
 * The optional sentence, posted from the page the click landed on.
 *
 * A plain form post so it works with no JavaScript, same as the vote. The vote
 * was already recorded by the GET, so this only ever adds; a rep who types
 * nothing has still told us what they thought.
 */
export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(token)) {
    return page("That link looks wrong", "Nothing was recorded.");
  }
  let note = "";
  try {
    const form = await req.formData();
    note = String(form.get("note") ?? "").trim().slice(0, 4000);
  } catch {
    return page("We could not read that", "Nothing was changed. Your rating is still saved.");
  }
  if (!note) {
    return page("Nothing to add, no problem", "Your rating is saved either way.");
  }
  try {
    const db = supabaseAdmin();
    const { error } = await db
      .from("sent_messages")
      .update({ feedback_note: note })
      .eq("feedback_token", token);
    if (error) throw new Error(error.message);
    console.log(`[feedback] note added (${note.length} chars) for ${token.slice(0, 8)}`);
    return page("Got it, thank you", "That is more useful than the rating on its own, and Maanit reads these.");
  } catch (err) {
    console.error(`[feedback] note write failed: ${err instanceof Error ? err.message : String(err)}`);
    // The rating survived. Say which half made it rather than implying both did.
    return page("We could not save that note", "Your rating was recorded, the note was not. Worth sending it to Maanit directly.");
  }
}
