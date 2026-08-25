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
  region?: string;
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
};

type RegionSummary = {
  key: string;
  label: string;
  coreArea: string | null;
  boardName: string;
  hackathonCount: number;
};

type Meta = {
  timezone: string;
  sweepCompletedAt: string;
  hackathonCount: number;
  adjacentCount: number;
  defaultRegion: string;
  regions: RegionSummary[];
};

const meta = discovery.meta as unknown as Meta;
const events = discovery.events as unknown as EventRecord[];
const regions = meta.regions;
const defaultRegion = meta.defaultRegion;

// Site copy, which is writing rather than data: a region gets its own lines when
// someone has written them, and a serviceable default until then.
const COPY: Record<string, { where: string; deck: string }> = {
  "bay-area": {
    where: "San Francisco Bay Area",
    deck:
      "Every hackathon across San Francisco and the wider Bay Area, kept " +
      "current morning and evening. Subscribe once and the next one finds " +
      "you — no more combing through invite links and half-dead group chats.",
  },
  "san-diego": {
    where: "San Diego County",
    deck:
      "Every hackathon from La Jolla to North County, kept current morning " +
      "and evening. Subscribe once and the next one finds you, instead of " +
      "combing through invite links and half-dead group chats.",
  },
};

function copyFor(region: RegionSummary) {
  return (
    COPY[region.key] ?? {
      where: region.label,
      deck:
        `Every hackathon across ${region.label}, kept current morning and ` +
        "evening. Subscribe once and the next one finds you.",
    }
  );
}

const updatedLabel = new Intl.DateTimeFormat("en-US", {
  timeZone: meta.timezone,
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
}).format(new Date(meta.sweepCompletedAt));

/** The origin is browser-only; the server snapshot keeps hydration honest. */
const subscribeToNothing = () => () => {};

const VIEWS = [
  "Hackathons",
  "Everything",
  "Open to join",
  "With prizes",
  "In the city",
];

function monthGroup(start: string | null, timezone: string) {
  if (!start) return "Dates to come";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "long",
    year: "numeric",
  }).format(new Date(start));
}

export default function Home() {
  const [regionKey, setRegionKey] = useState(defaultRegion);
  const [view, setView] = useState("Hackathons");
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);

  const region =
    regions.find((entry) => entry.key === regionKey) ?? regions[0];
  const copy = copyFor(region);
  // The default region keeps the bare path it has always had, so an existing
  // subscription is untouched by a second region existing.
  const feedPath =
    region.key === defaultRegion
      ? "/calendar.ics"
      : `/calendar.ics?region=${region.key}`;

  const origin = useSyncExternalStore(
    subscribeToNothing,
    () => window.location.origin,
    () => "",
  );
  const feedUrl = origin ? `${origin}${feedPath}` : feedPath;
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

  // The board is a twice-daily snapshot, so it always carries events that have
  // finished since it was written. Read once on mount rather than during render,
  // which keeps the render pure and still drops an event when it is over rather
  // than when the next sweep runs.
  const [asOf] = useState(() => Date.now());

  const inRegion = useMemo(
    // An event written before regions existed belongs to the default one, which
    // is where the single-region board had it. Without the fallback an older
    // data file would render every tab empty.
    () =>
      events.filter(
        (event) => (event.region ?? defaultRegion) === region.key,
      ),
    [region.key],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return inRegion
      .filter((event) => {
        const over = Date.parse(event.end ?? event.start ?? "");
        if (Number.isFinite(over) && over < asOf) return false;
        return true;
      })
      .filter((event) => {
        const haystack = `${event.title} ${event.organizer} ${event.tags.join(" ")} ${event.city ?? ""}`;
        if (needle && !haystack.toLowerCase().includes(needle)) return false;
        if (view === "Hackathons") return event.category === "hackathon";
        if (view === "Open to join")
          return ["Open", "Approval"].includes(event.status);
        if (view === "With prizes") return event.prize.includes("$");
        if (view === "In the city") return event.area === region.coreArea;
        return true;
      })
      .sort((a, b) => (a.start ?? "9999").localeCompare(b.start ?? "9999"));
  }, [inRegion, query, view, asOf, region.coreArea]);

  return (
    <main>
      <header className="masthead">
        <a className="wordmark" href="#top">Hacklist</a>
        {regions.length > 1 ? (
          <nav className="regions" aria-label="Choose a region">
            {regions.map((entry) => (
              <button
                key={entry.key}
                onClick={() => setRegionKey(entry.key)}
                className={entry.key === region.key ? "active" : ""}
                aria-pressed={entry.key === region.key}
              >
                {entry.label}
              </button>
            ))}
          </nav>
        ) : (
          <span className="masthead-meta">{copy.where}</span>
        )}
        <a className="masthead-cta" href="#subscribe">Subscribe</a>
      </header>

      <section className="lede" id="top">
        <p className="kicker">The {region.label} hackathon calendar</p>
        <h1>
          Everything worth building at,<br />
          <em>gathered in one place.</em>
        </h1>
        <p className="deck">{copy.deck}</p>
        <p className="byline">
          <b>
            {region.hackathonCount} hackathon
            {region.hackathonCount === 1 ? "" : "s"}
          </b>{" "}
          listed now
          <span aria-hidden="true"> · </span>
          Last checked {updatedLabel}
        </p>
      </section>

      <section className="subscribe" id="subscribe">
        <div className="subscribe-copy">
          <h2>Add it to your calendar</h2>
          <p>
            Works with Google, Apple, Outlook and anything else that reads a
            calendar link. New events arrive on their own.
          </p>
        </div>
        <div className="subscribe-actions">
          <div className="feed">
            <code title={feedUrl}>
              {origin ? `${origin.replace(/^https?:\/\//, "")}${feedPath}` : feedPath}
            </code>
            <button onClick={copyFeed} aria-label="Copy calendar link">
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
          {origin && (
            <p className="feed-links">
              <a href={googleUrl} target="_blank" rel="noreferrer">Google Calendar</a>
              <a href={webcalUrl}>Apple Calendar</a>
              <a href={feedPath} download>Download file</a>
            </p>
          )}
        </div>
      </section>

      <section className="listing" id="events">
        <div className="listing-head">
          <h2>What&rsquo;s coming up</h2>
          <label className="search">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by name, host or city"
              aria-label="Search events"
            />
          </label>
        </div>

        <nav className="views" aria-label="Filter events">
          {VIEWS.map((item) => (
            <button
              key={item}
              onClick={() => setView(item)}
              className={view === item ? "active" : ""}
            >
              {item}
            </button>
          ))}
          <span className="count">{visible.length} shown</span>
        </nav>

        <ol className="events">
          {visible.map((event, index) => {
            const group = monthGroup(event.start, meta.timezone);
            const newGroup =
              group !==
              monthGroup(visible[index - 1]?.start ?? null, meta.timezone);
            return (
              <li key={event.id}>
                {newGroup && <h3 className="month">{group}</h3>}
                <article className="event">
                  <time>
                    <b>{event.dateLabel}</b>
                    <span>{event.dateDetail}</span>
                  </time>
                  <div className="event-body">
                    <h4>
                      <a href={event.url} target="_blank" rel="noreferrer">
                        {event.title}
                      </a>
                    </h4>
                    <p className="event-where">
                      {event.organizer}
                      {event.venue || event.city ? (
                        <>
                          {" · "}
                          {[event.venue, event.city].filter(Boolean).join(", ")}
                        </>
                      ) : (
                        // Many hosts only reveal the address after you register,
                        // so there is often genuinely nothing to print. Say so and
                        // send people to the page that will tell them, rather than
                        // leaving a blank where a location should be.
                        <>
                          {" · "}
                          <a href={event.url} target="_blank" rel="noreferrer">
                            location on event page
                          </a>
                        </>
                      )}
                    </p>
                    <p className="event-note">{event.why}</p>
                  </div>
                  <div className="event-side">
                    <span
                      className={`status status-${event.status.toLowerCase().replace(/ /g, "-")}`}
                    >
                      {event.status}
                    </span>
                    {event.prize !== "Not listed" && (
                      <span className="prize">{event.prize}</span>
                    )}
                    {event.category === "adjacent" && (
                      <span className="aside-tag">Not a hackathon</span>
                    )}
                  </div>
                </article>
              </li>
            );
          })}
          {visible.length === 0 && (
            <li className="empty">
              {inRegion.length === 0
                ? `Nothing on the ${region.label} board yet. The sweep runs every ` +
                  "morning and evening, and anything it finds lands here and in " +
                  "the feed."
                : "Nothing matches that. Try a different view."}
            </li>
          )}
        </ol>
      </section>

      <footer>
        <p className="footer-brand">Hacklist</p>
        <p>
          For the people who would rather be building than hunting for somewhere
          to build.
        </p>
        <a href="#top">Back to top</a>
      </footer>
    </main>
  );
}
