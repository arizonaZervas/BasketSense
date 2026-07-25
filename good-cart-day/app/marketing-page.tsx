"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

type SubmissionState = "idle" | "sending" | "complete" | "error";

declare global {
  interface Window {
    turnstile?: {
      render: (element: HTMLElement, options: { sitekey: string; callback: (token: string) => void; "error-callback": () => void; theme: "light" }) => string;
      remove: (widgetId: string) => void;
    };
  }
}

export function MarketingPage({ turnstileSiteKey }: { turnstileSiteKey?: string }) {
  const [state, setState] = useState<SubmissionState>("idle");
  const [message, setMessage] = useState("");
  const tokenRef = useRef<HTMLInputElement>(null);
  const turnstileRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!turnstileSiteKey || !turnstileRef.current) return;
    const mount = () => {
      if (!turnstileRef.current || !window.turnstile) return;
      const widgetId = window.turnstile.render(turnstileRef.current, {
        sitekey: turnstileSiteKey,
        theme: "light",
        callback: (token) => { if (tokenRef.current) tokenRef.current.value = token; },
        "error-callback": () => { if (tokenRef.current) tokenRef.current.value = ""; },
      });
      return () => window.turnstile?.remove(widgetId);
    };
    const existing = document.querySelector<HTMLScriptElement>('script[data-good-cart-day-turnstile="true"]');
    if (existing) { const cleanup = mount(); return () => cleanup?.(); }
    const script = document.createElement("script"); script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; script.async = true; script.dataset.goodCartDayTurnstile = "true";
    script.onload = () => { mount(); }; document.head.append(script);
  }, [turnstileSiteKey]);

  async function joinBeta(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setState("sending");
    setMessage("");
    try {
      const response = await fetch("/api/beta-interest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: form.get("email"),
          consent: form.get("consent") === "on",
          company: form.get("company"),
          turnstileToken: tokenRef.current?.value ?? "",
        }),
      });
      if (!response.ok) throw new Error("unable to submit");
      setState("complete");
      setMessage("Thanks — we’ll be in touch if there’s a beta spot for your household.");
      event.currentTarget.reset();
    } catch {
      setState("error");
      setMessage("That did not go through. Please try again in a moment.");
    }
  }

  return (
    <main className="gcd-page">
      <header className="gcd-nav">
        <a className="gcd-wordmark" href="#top" aria-label="Good Cart Day home">
          <span className="gcd-mark" aria-hidden="true">G</span>
          <span>Good Cart Day</span>
        </a>
        <a className="gcd-signin" href="/sign-in">Sign in</a>
      </header>

      <section className="gcd-hero" id="top">
        <div className="gcd-hero-copy">
          <p className="gcd-kicker">A shared Costco companion</p>
          <h1>Came for milk. <span>Left with a $400 cart?</span></h1>
          <p className="gcd-lede">Plan the trip. Keep the treasure hunt.</p>
          <p className="gcd-support">One shared list, a running estimate, and a calm look back at the receipt — so your Saturday ritual stays fun and your cart stays intentional.</p>
          <a className="gcd-primary" href="#join">Join the private beta <span aria-hidden="true">→</span></a>
          <p className="gcd-note">Independent household tool. Not affiliated with Costco.</p>
        </div>
        <div className="gcd-phone-wrap" aria-label="Illustration of a synthetic Good Cart Day shared shopping list">
          <div className="gcd-phone">
            <div className="gcd-phone-top"><span>Saturday list</span><span>2 editing</span></div>
            <div className="gcd-phone-total"><small>Estimated today</small><strong>$164<span>.62</span></strong><em>Known items only</em></div>
            <div className="gcd-list-row"><b className="gcd-check">✓</b><span>Organic milk</span><strong>$8.99</strong></div>
            <div className="gcd-list-row"><b className="gcd-check">✓</b><span>Strawberries</span><strong>$6.49</strong></div>
            <div className="gcd-list-row"><b className="gcd-check empty" /><span>Rice</span><button type="button">Add estimate</button></div>
            <div className="gcd-discovery"><span>Treasure-hunt room</span><strong>$35</strong><small>For the delightful unexpected</small></div>
            <div className="gcd-phone-foot"><span>List</span><span>Receipt</span><span>Insights</span></div>
          </div>
          <p className="gcd-scribble">Milk achieved. Adventure intact.</p>
        </div>
      </section>

      <section className="gcd-story" aria-labelledby="story-heading">
        <div><p className="gcd-kicker">A small weekly loop</p><h2 id="story-heading">Less “where did that come from?” More “glad we got that.”</h2></div>
        <ol>
          <li><span>01</span><h3>Plan together</h3><p>Start from the things your household actually repeats. Add whatever else matters this week.</p></li>
          <li><span>02</span><h3>Enjoy the trip</h3><p>See a live, editable estimated total — with room for a genuinely good discovery.</p></li>
          <li><span>03</span><h3>Learn from the receipt</h3><p>Compare intent and reality, fix ambiguous products, and make next Saturday a little easier.</p></li>
        </ol>
      </section>

      <section className="gcd-proof" aria-label="What Good Cart Day helps a household do">
        <article><p className="gcd-kicker">One list, two phones</p><h2>Both people see the same plan.</h2><p>Make the list before leaving. Check items in the warehouse. No screenshots, no “did you already add that?” text thread.</p></article>
        <article className="gcd-receipt-card"><p>Receipt review</p><div><span>Planned list</span><strong>$164.62</strong></div><div><span>Receipt total</span><strong>$182.18</strong></div><div className="gcd-positive"><span>Worth-it discovery</span><strong>Park snack bag</strong></div><small>Households decide what was worth it. The app does not make that call for you.</small></article>
      </section>

      <section className="gcd-join" id="join" aria-labelledby="join-heading">
        <div><p className="gcd-kicker">Private beta</p><h2 id="join-heading">Build a better Saturday with us.</h2><p>We are inviting a small number of households while we prove the weekly loop. Interest does not create an account.</p></div>
        <form onSubmit={joinBeta} className="gcd-form">
          <label htmlFor="beta-email">Email address</label>
          <input id="beta-email" name="email" type="email" autoComplete="email" required placeholder="you@example.com" />
          <input className="gcd-honeypot" name="company" tabIndex={-1} autoComplete="off" aria-hidden="true" />
          <input ref={tokenRef} type="hidden" name="turnstileToken" />
          <div ref={turnstileRef} aria-label="Spam protection" />
          <label className="gcd-consent"><input name="consent" type="checkbox" required /> <span>I agree that Good Cart Day may store this email to respond about the private beta.</span></label>
          <button className="gcd-primary" type="submit" disabled={state === "sending"}>{state === "sending" ? "Joining…" : "Join the private beta →"}</button>
          <p className={`gcd-form-message ${state}`} aria-live="polite">{message}</p>
        </form>
      </section>

      <section className="gcd-faq" aria-labelledby="faq-heading"><h2 id="faq-heading">A few honest answers</h2><details><summary>Does it connect to Costco?</summary><p>No. Good Cart Day does not store Costco credentials or automate Costco login. Receipt upload is deliberately household-controlled.</p></details><details><summary>Will it guarantee savings?</summary><p>No. A lower total is not the only goal. The aim is a more intentional, easier weekly trip.</p></details><details><summary>Who can see our data?</summary><p>Your household only. The beta is invite-only; product data is not used for public dashboards or shared across households.</p></details></section>

      <footer className="gcd-footer"><span>© 2026 Good Cart Day</span><span><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/sign-in">Sign in</a></span></footer>
    </main>
  );
}
