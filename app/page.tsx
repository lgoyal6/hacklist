"use client";

import { useMemo, useState } from "react";

type Event = {
  id: number;
  title: string;
  organizer: string;
  place: string;
  area: "SF" | "Peninsula" | "South Bay";
  date: string;
  dateDetail: string;
  score: number;
  confidence: number;
  status: "Open" | "Approval" | "Waitlist" | "Sold out";
  tags: string[];
  prize: string;
  sourceCount: number;
  url: string;
  why: string;
};

const events: Event[] = [
  {
    id: 1,
    title: "Close the Loop — Voice AI Hackathon",
    organizer: "a1mobile",
    place: "San Francisco",
    area: "SF",
    date: "JUL 31",
    dateDetail: "Fri · 9am–9pm",
    score: 98,
    confidence: 99,
    status: "Approval",
    tags: ["Voice AI", "Agents", "12 hours"],
    prize: "$4K prizes",
    sourceCount: 3,
    url: "https://luma.com/f8cratbb",
    why: "12-hour build, live judging, concrete challenge, cash prizes.",
  },
  {
    id: 2,
    title: "Memory Meets Motion: Hackathon",
    organizer: "Devnovate",
    place: "Frontier Tower · 995 Market",
    area: "SF",
    date: "AUG 03",
    dateDetail: "Mon · 8am–3:30pm",
    score: 95,
    confidence: 98,
    status: "Open",
    tags: ["AI", "Agents", "Frontier tech"],
    prize: "Prizes listed",
    sourceCount: 2,
    url: "https://luma.com/iu9svaun",
    why: "Dedicated build day with technical tracks and a concrete submission format.",
  },
  {
    id: 3,
    title: "Pizza Agent Challenge",
    organizer: "AlphaSignal",
    place: "San Francisco",
    area: "SF",
    date: "AUG 06",
    dateDetail: "Thu · 5:30–9pm",
    score: 93,
    confidence: 98,
    status: "Approval",
    tags: ["AI Agents", "90 min", "Live"],
    prize: "$2.5K top prize",
    sourceCount: 2,
    url: "https://luma.com/o0id5abn",
    why: "Timed build-from-scratch competition with a live result and vote.",
  },
  {
    id: 4,
    title: "Snowflake × Beta Fund Agent & Token Economy",
    organizer: "Beta University",
    place: "Menlo Park",
    area: "Peninsula",
    date: "AUG 07",
    dateDetail: "Fri · 9am–6pm",
    score: 91,
    confidence: 99,
    status: "Approval",
    tags: ["AI", "Snowflake", "Agents"],
    prize: "$1.5K cash",
    sourceCount: 3,
    url: "https://luma.com/beta-fdnw",
    why: "Full build day, three tracks, hard deadline, demos and awards.",
  },
  {
    id: 5,
    title: "AI for Social Good @ Open Atlas Summit",
    organizer: "Open Atlas",
    place: "India Community Center · Milpitas",
    area: "South Bay",
    date: "AUG 21",
    dateDetail: "Fri · 9am–5pm",
    score: 90,
    confidence: 97,
    status: "Open",
    tags: ["Social impact", "AI", "Demo day"],
    prize: "Awards",
    sourceCount: 2,
    url: "https://luma.com/s6pv7mw1",
    why: "Teams build for two months, then demo live to judges at the summit.",
  },
  {
    id: 6,
    title: "Better Days: A Hackathon",
    organizer: "ClickHouse Events",
    place: "KOHO Co-Creative Hub",
    area: "SF",
    date: "AUG 28",
    dateDetail: "Fri · 9am–7pm",
    score: 87,
    confidence: 91,
    status: "Open",
    tags: ["Analytics", "AI", "Open theme"],
    prize: "Not listed",
    sourceCount: 2,
    url: "https://luma.com/clickh-sie8",
    why: "Confirmed full-day hackathon in SF; prize and judging details need verification.",
  },
  {
    id: 7,
    title: "AI Hackathon: Sales Copilot AI",
    organizer: "TatianaSF",
    place: "San Francisco",
    area: "SF",
    date: "SEP 05",
    dateDetail: "Sat · 11am–7pm",
    score: 84,
    confidence: 94,
    status: "Open",
    tags: ["Sales AI", "Agents", "Vibe coding"],
    prize: "Prizes listed",
    sourceCount: 2,
    url: "https://luma.com/qzct3ybt",
    why: "Eight-hour build with builder tickets and a defined AI sales theme.",
  },
  {
    id: 8,
    title: "AI Infra Summit Hackathon",
    organizer: "lablab.ai",
    place: "Santa Clara Convention Center",
    area: "South Bay",
    date: "SEP 15",
    dateDetail: "Tue–Thu · 3 days",
    score: 82,
    confidence: 97,
    status: "Open",
    tags: ["AI infra", "Compute", "Physical AI"],
    prize: "Not listed",
    sourceCount: 2,
    url: "https://luma.com/lablab-zbl9",
    why: "Multi-day builder event with technical infrastructure tracks; lower rank for travel radius.",
  },
];

const filters = ["All", "Open now", "AI", "SF proper", "Cash prizes"];

function StatusDot({ status }: { status: Event["status"] }) {
  return <span className={`status status-${status.toLowerCase().replace(" ", "-")}`}>{status}</span>;
}

export default function Home() {
  const [filter, setFilter] = useState("All");
  const [sort, setSort] = useState<"relevance" | "date">("relevance");
  const [query, setQuery] = useState("");

  const visibleEvents = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const list = events.filter((event) => {
      const matchesQuery =
        !normalized ||
        `${event.title} ${event.organizer} ${event.tags.join(" ")}`
          .toLowerCase()
          .includes(normalized);
      const matchesFilter =
        filter === "All" ||
        (filter === "Open now" && ["Open", "Approval"].includes(event.status)) ||
        (filter === "AI" && event.tags.some((tag) => tag.toLowerCase().includes("ai") || tag === "Agents")) ||
        (filter === "SF proper" && event.area === "SF") ||
        (filter === "Cash prizes" && event.prize.toLowerCase().includes("$"));
      return matchesQuery && matchesFilter;
    });
    return [...list].sort((a, b) =>
      sort === "relevance" ? b.score - a.score : a.id - b.id,
    );
  }, [filter, query, sort]);

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Hacklist SF home">
          <span className="brand-mark">H/</span>
          <span>HACKLIST</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#events">Discover</a>
          <a href="#coverage">Coverage</a>
          <a href="#method">Method</a>
        </nav>
        <a className="calendar-button" href="/calendar.ics">
          <span>＋</span> Add SF calendar
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
        <div><strong>13</strong><span>sweep candidates</span></div>
        <div><strong>31</strong><span>organizer nodes</span></div>
        <div><strong>12</strong><span>source surfaces</span></div>
        <div><strong>2×</strong><span>daily refresh</span></div>
        <p>LAST SWEEP<br /><b>JUL 30 · 6:00 PM PT</b></p>
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
            {visibleEvents.map((event, index) => (
              <article className="event-card" key={event.id}>
                <div className="rank">{String(index + 1).padStart(2, "0")}</div>
                <div className="event-date">
                  <b>{event.date}</b>
                  <span>{event.dateDetail}</span>
                </div>
                <div className="event-main">
                  <div className="event-meta">
                    <StatusDot status={event.status} />
                    <span>{event.area}</span>
                    <span>{event.prize}</span>
                  </div>
                  <h3><a href={event.url} target="_blank" rel="noreferrer">{event.title}</a></h3>
                  <p>By <b>{event.organizer}</b> · {event.place}</p>
                  <div className="tags">
                    {event.tags.map((tag) => <span key={tag}>{tag}</span>)}
                  </div>
                  <details>
                    <summary>Why this score</summary>
                    <p>{event.why} Confirmed across {event.sourceCount} source{event.sourceCount > 1 ? "s" : ""}; {event.confidence}% classification confidence.</p>
                  </details>
                </div>
                <div className="score" aria-label={`${event.score} relevance score`}>
                  <strong>{event.score}</strong>
                  <span>RELEVANCE</span>
                </div>
              </article>
            ))}
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
              <li><span className="source-index">A</span><div><b>Luma surfaces</b><small>Explore, categories, calendar pages</small></div><strong>04</strong></li>
              <li><span className="source-index">B</span><div><b>Organizer graph</b><small>Hosts, co-hosts, presented-by</small></div><strong>31</strong></li>
              <li><span className="source-index">C</span><div><b>Open-web index</b><small>Queries, variants, date windows</small></div><strong>06</strong></li>
              <li><span className="source-index">D</span><div><b>Known collections</b><small>Used as seeds, never truth</small></div><strong>02</strong></li>
            </ul>
          </div>

          <div className="aside-card next-sweep">
            <span>NEXT SWEEP</span>
            <strong>08:00 PM</strong>
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
