"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import discovery from "../data/events.json";

type EventRecord = {
  id: string;
  url: string;
  platform: "luma" | "external";
  category: "hackathon" | "adjacent";
  adjacentReason: string | null;
  title: string;
  organizer: string;
  venue: string | null;
  city: string | null;
  area: string;
  start: string | null;
  end: string | null;
  timezone: string;
  dateLabel: string;
  dateDetail: string;
  status: string;
  prize: string;
  tags: string[];
  going: number | null;
  why: string;
  score: number;
  confidence: number;
  scores: {
    confidence: number;
    builderValue: number;
    accessibility: number;
    freshness: number;
  };
  discoveredVia: string;
  checkedAt: string;
};

type Meta = {
  city: string;
  timezone: string;
  sweepCompletedAt: string;
  pagesVisited: number;
  candidatesFound: number;
  publishedCount: number;
  organizerCount: number;
  sourceCount: number;
  seedCount: number;
  externalCount: number;
  hackathonCount: number;
  adjacentCount: number;
};

const meta = discovery.meta as Meta;
const events = discovery.events as EventRecord[];

const lastSweepLabel = `${new Intl.DateTimeFormat("en-US", {
  timeZone: meta.timezone,
  month: "short",
  day: "2-digit",
  hour: "numeric",
  minute: "2-digit",
})
  .format(new Date(meta.sweepCompletedAt))
  .replace(",", " ·")
  .toUpperCase()} PT`;

const sweepHour = Number(
  new Intl.DateTimeFormat("en-US", {
    timeZone: meta.timezone,
    hour: "numeric",
    hour12: false,
  }).format(new Date(meta.sweepCompletedAt)),
);
const nextSweepLabel = sweepHour >= 8 && sweepHour < 20 ? "08:00 PM" : "08:00 AM";

/** The origin never changes within a page load, so there is nothing to watch. */
const subscribeToNothing = () => () => {};

/** Coarse time buckets, so a long list stays scannable when sorted by date. */
function timeBucket(start: string | null): string {
  if (!start) return "Date to be confirmed";
  const days = (new Date(start).getTime() - Date.now()) / 86_400_000;
  if (days < 0) return "Happening now";
  if (days <= 7) return "This week";
  if (days <= 14) return "Next week";
  if (days <= 31) return "This month";
  return "Later";
}

const filters = [
  "Hackathons",
  "All",
  "Open now",
  "AI",
  "SF proper",
  "Cash prizes",
  "Adjacent",
];

function sourceLabel(via: string) {
  try {
    const url = new URL(via);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return via;
  }
}

function StatusDot({ status }: { status: string }) {
  return (
    <span className={`status status-${status.toLowerCase().replace(/ /g, "-")}`}>
      {status}
    </span>
  );
}

export default function Home() {
  const [filter, setFilter] = useState("Hackathons");
  const [copied, setCopied] = useState(false);
  const [sort, setSort] = useState<"relevance" | "date">("relevance");
  const [query, setQuery] = useState("");

  const visibleEvents = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const list = events.filter((event) => {
      const matchesQuery =
        !normalized ||
        `${event.title} ${event.organizer} ${event.tags.join(" ")} ${event.city ?? ""}`
          .toLowerCase()
          .includes(normalized);
      const matchesFilter =
        filter === "All" ||
        (filter === "Hackathons" && event.category === "hackathon") ||
        (filter === "Adjacent" && event.category === "adjacent") ||
        (filter === "Open now" && ["Open", "Approval"].includes(event.status)) ||
        (filter === "AI" &&
          (event.tags.some((tag) => /ai|agent/i.test(tag)) ||
            /\bai\b/i.test(event.title))) ||
        (filter === "SF proper" && event.area === "SF") ||
        (filter === "Cash prizes" && event.prize.includes("$"));
      return matchesQuery && matchesFilter;
    });
    return [...list].sort((a, b) =>
      sort === "relevance"
        ? b.score - a.score
        : (a.start ?? "9999").localeCompare(b.start ?? "9999"),
    );
  }, [filter, query, sort]);

  // The server has no location, so this is read as an external value with an
  // explicit server snapshot: reading `window` during render would produce
  // different markup on each side and break hydration.
  const origin = useSyncExternalStore(
    subscribeToNothing,
    () => window.location.origin,
    () => "",
  );
  const feedUrl = origin ? `${origin}/calendar.ics` : "/calendar.ics";
  const webcalUrl = feedUrl.replace(/^https?:/, "webcal:");
  const googleUrl = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl)}`;

  const copyFeed = async () => {
    try {
      await navigator.clipboard.writeText(feedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Hacklist SF home">
          <span className="brand-mark">H/</span>
          <span>HACKLIST</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#events">Discover</a>
          <a href="#subscribe">Subscribe</a>
          <a href="#coverage">Coverage</a>
          <a href="#method">Method</a>
        </nav>
        <a className="calendar-button" href="#subscribe">
          <span>＋</span> Subscribe
        </a>
      </header>

      <section className="hero" id="top">
        <div className="eyebrow"><span className="pulse" /> SF BAY AREA · PROTOTYPE 01</div>
        <h1>Every hackathon.<br /><em>Ranked by signal.</em></h1>
        <p className="hero-copy">
          A twice-daily sweep across Luma discovery, hidden calendars, organizers,
          co-hosts, and the open web—starting with San Francisco.
        </p>
        <div className="city-switcher" aria-label="Choose city">
          <button className="city-active"><span>01</span> San Francisco</button>
          <button disabled><span>02</span> San Diego <small>NEXT</small></button>
          <button disabled><span>03</span> New York <small>QUEUE</small></button>
          <button disabled><span>04</span> Austin <small>QUEUE</small></button>
        </div>
      </section>

      <section className="signal-strip" aria-label="Coverage summary">
        <div><strong>{meta.hackathonCount}</strong><span>hackathons</span></div>
        <div><strong>{meta.adjacentCount}</strong><span>adjacent events</span></div>
        <div><strong>{meta.organizerCount}</strong><span>organizer nodes</span></div>
        <div><strong>{meta.pagesVisited}</strong><span>pages per sweep</span></div>
        <div><strong>2×</strong><span>daily refresh</span></div>
        <p>LAST SWEEP<br /><b>{lastSweepLabel}</b></p>
      </section>

      <section className="subscribe" id="subscribe">
        <div className="subscribe-copy">
          <span className="section-number">◎</span>
          <h2>Put it in your calendar</h2>
          <p>
            {meta.hackathonCount} hackathons, refreshed twice a day. Subscribe
            once and new ones appear on their own — no checking back.
          </p>
        </div>
        <div className="subscribe-actions">
          <div className="feed-url">
            <code>{feedUrl || "/calendar.ics"}</code>
            <button onClick={copyFeed} aria-label="Copy calendar feed URL">
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>
          <div className="feed-buttons">
            {origin && (
              <>
                <a href={googleUrl} target="_blank" rel="noreferrer">Google Calendar</a>
                <a href={webcalUrl}>Apple Calendar</a>
              </>
            )}
            <a href="/calendar.ics" download>Download .ics</a>
          </div>
          <small>
            Outlook, Notion and everything else: paste the URL above into
            &ldquo;subscribe from web&rdquo;. Adjacent events are prefixed
            [Adjacent] so they never read as hackathons.
          </small>
        </div>
      </section>

      <section className="content-grid" id="events">
        <div className="events-column">
          <div className="section-heading">
            <div>
              <span className="section-number">01</span>
              <h2>SF signal board</h2>
            </div>
            <p>{visibleEvents.length} matches · Bay Area radius</p>
          </div>

          <div className="toolbar">
            <label className="search">
              <span>⌕</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search theme or organizer"
                aria-label="Search events"
              />
            </label>
            <div className="sort">
              <span>SORT</span>
              <button
                className={sort === "relevance" ? "selected" : ""}
                onClick={() => setSort("relevance")}
              >
                Relevance
              </button>
              <button
                className={sort === "date" ? "selected" : ""}
                onClick={() => setSort("date")}
              >
                Date
              </button>
            </div>
          </div>

          <div className="filter-row">
            {filters.map((item) => (
              <button
                key={item}
                onClick={() => setFilter(item)}
                className={filter === item ? "active" : ""}
              >
                {item}
              </button>
            ))}
          </div>

          <div className="event-list">
            {visibleEvents.map((event, index) => {
              const bucket = timeBucket(event.start);
              const showBucket =
                sort === "date" &&
                bucket !== timeBucket(visibleEvents[index - 1]?.start ?? null);
              return (
              <div key={event.id}>
              {showBucket && <h3 className="bucket-heading">{bucket}</h3>}
              <article className="event-card">
                <div className="rank">{String(index + 1).padStart(2, "0")}</div>
                <div className="event-date">
                  <b>{event.dateLabel}</b>
                  <span>{event.dateDetail}</span>
                </div>
                <div className="event-main">
                  <div className="event-meta">
                    <StatusDot status={event.status} />
                    {event.category === "adjacent" && (
                      <span className="adjacent-badge">Adjacent</span>
                    )}
                    <span>{event.area}</span>
                    <span>{event.prize}</span>
                    {event.going ? <span>{event.going} going</span> : null}
                  </div>
                  <h3><a href={event.url} target="_blank" rel="noreferrer">{event.title}</a></h3>
                  <p>
                    By <b>{event.organizer}</b>
                    {" · "}
                    {[event.venue, event.city].filter(Boolean).join(" · ") ||
                      "Location on event page"}
                  </p>
                  <div className="tags">
                    {event.tags.map((tag) => <span key={tag}>{tag}</span>)}
                  </div>
                  <details>
                    <summary>Why this score</summary>
                    <p>
                      {event.category === "adjacent" && (
                        <><b>Adjacent, not a hackathon</b>
                        {event.adjacentReason ? ` — ${event.adjacentReason}. ` : ". "}</>
                      )}
                      {event.why} Confidence {event.scores.confidence} · builder
                      value {event.scores.builderValue} · accessibility{" "}
                      {event.scores.accessibility} · freshness{" "}
                      {event.scores.freshness}. Found via {sourceLabel(event.discoveredVia)}.
                    </p>
                  </details>
                </div>
                <div className="score" aria-label={`${event.score} relevance score`}>
                  <strong>{event.score}</strong>
                  <span>RELEVANCE</span>
                </div>
              </article>
              </div>
              );
            })}
            {visibleEvents.length === 0 && (
              <div className="empty">No events match this view. Try clearing the filter.</div>
            )}
          </div>
        </div>

        <aside id="coverage">
          <div className="aside-card coverage-card">
            <span className="section-number">02</span>
            <h2>Coverage radar</h2>
            <p>Not one list. A graph that keeps finding new paths.</p>
            <div className="radar">
              <div className="radar-ring ring-1" />
              <div className="radar-ring ring-2" />
              <div className="radar-ring ring-3" />
              <i className="dot dot-1" /><i className="dot dot-2" />
              <i className="dot dot-3" /><i className="dot dot-4" />
              <i className="sweep" />
              <b>SF</b>
            </div>
            <ul className="source-list">
              <li><span className="source-index">A</span><div><b>Luma surfaces</b><small>Explore, categories, calendar pages</small></div><strong>{String(meta.seedCount).padStart(2, "0")}</strong></li>
              <li><span className="source-index">B</span><div><b>Organizer graph</b><small>Hosts, co-hosts, presented-by</small></div><strong>{String(meta.organizerCount).padStart(2, "0")}</strong></li>
              <li><span className="source-index">C</span><div><b>External listings</b><small>Off-Luma events linked by public sources</small></div><strong>{String(meta.externalCount).padStart(2, "0")}</strong></li>
              <li><span className="source-index">D</span><div><b>Discovery paths</b><small>Distinct surfaces that yielded events</small></div><strong>{String(meta.sourceCount).padStart(2, "0")}</strong></li>
            </ul>
          </div>

          <div className="aside-card next-sweep">
            <span>NEXT SWEEP</span>
            <strong>{nextSweepLabel}</strong>
            <p>Morning + evening, America/Los_Angeles</p>
            <div><i /> Discovery healthy</div>
          </div>
        </aside>
      </section>

      <section className="method" id="method">
        <div className="section-heading">
          <div><span className="section-number">03</span><h2>How ranking works</h2></div>
          <p>Readable evidence, not a mystery score.</p>
        </div>
        <div className="method-grid">
          <article><span>40%</span><h3>Hackathon confidence</h3><p>Building time, teams, submissions, judges, demos and prizes.</p></article>
          <article><span>25%</span><h3>Builder value</h3><p>Technical depth, mentor access, useful sponsors and credible tracks.</p></article>
          <article><span>20%</span><h3>Accessibility</h3><p>Registration state, price, travel radius and approval friction.</p></article>
          <article><span>15%</span><h3>Freshness</h3><p>Upcoming date, recently verified source and active registration.</p></article>
        </div>
        <div className="method-note">
          <b>Candidate ≠ confirmed.</b>
          <p>A broad matcher finds unusual names such as “Pizza Agent Challenge.” A page-level classifier then looks for actual building, judging and submission evidence before publishing.</p>
        </div>
      </section>

      <footer>
        <div className="brand"><span className="brand-mark">H/</span><span>HACKLIST</span></div>
        <p>Prototype for the people who would rather build than search.</p>
        <a href="#top">Back to top ↑</a>
      </footer>
    </main>
  );
}
