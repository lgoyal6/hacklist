"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import discovery from "../data/events.json";
import {
  LOCALES,
  hasMessage,
  localePath,
  translator,
  type Locale,
} from "./i18n";
import {
  formatEventDate,
  monthGroupLabel,
  updatedStampLabel,
} from "./i18n/dates.mjs";
import { boardVisible, regionOf } from "./ranking.mjs";

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
  timeUnverified?: boolean;
  status: string;
  prize: string;
  tags: string[];
  going: number | null;
  why: string;
  score: number;
  // A sweep that cannot reach a listing republishes it from the last snapshot
  // rather than dropping the row off every subscription. These two are what a
  // renderer needs to say "last confirmed on the 4th" instead of showing a
  // three-day-old row as if it had been read this morning.
  missedSweeps?: number;
  provenance?: {
    kind: "observed" | "carried-forward";
    carriedFrom?: { file: string; sweepCompletedAt: string | null } | null;
    lastConfirmedAt?: string | null;
  };
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

/** The origin is browser-only; the server snapshot keeps hydration honest. */
const subscribeToNothing = () => () => {};

// The view a filter button selects. Keys, not display strings, so the selected
// view survives a language switch and the filter logic never reads copy.
const VIEWS = ["hackathons", "everything", "open", "prizes", "city"] as const;
type View = (typeof VIEWS)[number];

export default function Board({ locale }: { locale: Locale }) {
  const { t, plural } = useMemo(() => translator(locale), [locale]);
  const [regionKey, setRegionKey] = useState(defaultRegion);
  const [view, setView] = useState<View>("hackathons");
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);

  const region =
    regions.find((entry) => entry.key === regionKey) ?? regions[0];
  // Site copy, which is writing rather than data: a region gets its own lines
  // in each catalog when someone has written them, and a serviceable default
  // until then.
  const copy = hasMessage(`copy.${region.key}.deck`)
    ? {
        where: t(`copy.${region.key}.where`),
        deck: t(`copy.${region.key}.deck`),
      }
    : {
        where: region.label,
        deck: t("copy.default.deck", { region: region.label }),
      };
  // The default region keeps the bare path it has always had, so an existing
  // subscription is untouched by a second region existing. The path is also
  // deliberately locale-free: both languages name one feed, so switching
  // language can never mint a second subscription.
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

  const updatedLabel = updatedStampLabel(
    meta.sweepCompletedAt,
    meta.timezone,
    locale,
  );

  const inRegion = useMemo(
    // An event written before regions existed belongs to the default one, which
    // is where the single-region board had it. Without the fallback an older
    // data file would render every tab empty.
    () =>
      events.filter((event) => regionOf(event, defaultRegion) === region.key),
    [region.key],
  );

  // The filter and the sort live in app/ranking.mjs, and this is the only
  // caller: an ordering the evaluator re-implements is an ordering nobody has
  // actually measured. results/recommender-manifest.json freezes a snapshot of
  // what this returns on the committed data file, and a test compares them.
  const visible = useMemo<EventRecord[]>(
    () =>
      boardVisible(events, {
        regionKey: region.key,
        coreArea: region.coreArea,
        defaultRegion,
        view,
        query,
        asOf,
      }) as EventRecord[],
    [region.key, region.coreArea, view, query, asOf],
  );

  /** A status pill's text is copy; its identity (and CSS class) stays the raw value. */
  const statusLabel = (status: string) => {
    const key = `status.${status.toLowerCase().replace(/ /g, "-")}`;
    return hasMessage(key) ? t(key) : status;
  };

  return (
    <main>
      <header className="masthead">
        <a className="wordmark" href="#top">Hacklist</a>
        {regions.length > 1 ? (
          <nav className="regions" aria-label={t("masthead.regionNav")}>
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
        {/* Real links to real routes, not client state: the language you read
            the board in is an address you can bookmark, share, and land on. */}
        <nav className="locales" aria-label={t("masthead.localeNav")}>
          {LOCALES.map((entry) => (
            <a
              key={entry}
              href={localePath(entry)}
              hrefLang={entry}
              lang={entry}
              aria-label={t(`locale.${entry}`)}
              aria-current={entry === locale ? "page" : undefined}
              className={entry === locale ? "active" : ""}
            >
              {t(`locale.${entry}.short`)}
            </a>
          ))}
        </nav>
        <a className="masthead-cta" href="#subscribe">{t("masthead.subscribe")}</a>
      </header>

      <section className="lede" id="top">
        <p className="kicker">{t("lede.kicker", { region: region.label })}</p>
        <h1>
          {t("lede.title.line1")}<br />
          <em>{t("lede.title.line2")}</em>
        </h1>
        <p className="deck">{copy.deck}</p>
        <p className="byline">
          <b>{plural("byline.count", region.hackathonCount)}</b>{" "}
          {plural("byline.listed", region.hackathonCount)}
          <span aria-hidden="true"> · </span>
          {t("byline.checked", { date: updatedLabel })}
        </p>
      </section>

      <section className="subscribe" id="subscribe">
        <div className="subscribe-copy">
          <h2>{t("subscribe.title")}</h2>
          <p>{t("subscribe.body")}</p>
        </div>
        <div className="subscribe-actions">
          <div className="feed">
            <code title={feedUrl}>
              {origin ? `${origin.replace(/^https?:\/\//, "")}${feedPath}` : feedPath}
            </code>
            {/* The announced name has to move with the visible one: a label
                that stays "Copy calendar link" makes the confirmation visual
                only, and it does not contain the visible "Copy link" either,
                which is what WCAG 2.5.3 asks for so speech input can say what
                it sees. Both catalogs keep the visible label inside the
                announced one, and the test checks each language. */}
            <button
              onClick={copyFeed}
              aria-label={
                copied ? t("subscribe.copiedAria") : t("subscribe.copyAria")
              }
            >
              {copied ? t("subscribe.copied") : t("subscribe.copy")}
            </button>
          </div>
          {origin && (
            <p className="feed-links">
              <a href={googleUrl} target="_blank" rel="noreferrer">{t("subscribe.google")}</a>
              <a href={webcalUrl}>{t("subscribe.apple")}</a>
              <a href={feedPath} download>{t("subscribe.download")}</a>
            </p>
          )}
        </div>
      </section>

      <section className="listing" id="events">
        <div className="listing-head">
          <h2>{t("listing.title")}</h2>
          <label className="search">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("listing.searchPlaceholder")}
              aria-label={t("listing.searchAria")}
            />
          </label>
        </div>

        <nav className="views" aria-label={t("listing.viewsAria")}>
          {VIEWS.map((item) => (
            <button
              key={item}
              onClick={() => setView(item)}
              className={view === item ? "active" : ""}
              aria-pressed={view === item}
            >
              {t(`views.${item}`)}
            </button>
          ))}
          {/* Typing or picking a filter rewrites this and nothing else, so it
              is the only confirmation the search worked. Announced politely,
              which lets a screen reader finish the keystroke first. */}
          <span className="count" role="status" aria-live="polite">
            {plural("listing.shown", visible.length)}
          </span>
        </nav>

        <ol className="events">
          {visible.map((event, index) => {
            const group = monthGroupLabel(
              event.start,
              meta.timezone,
              locale,
              t,
            );
            const newGroup =
              group !==
              monthGroupLabel(
                visible[index - 1]?.start ?? null,
                meta.timezone,
                locale,
                t,
              );
            // Rendered from the event's instant in the event's own zone, so the
            // words follow the locale and the moment follows the event.
            const when = formatEventDate(event, locale, t);
            return (
              <li key={event.id}>
                {newGroup && <h3 className="month">{group}</h3>}
                <article className="event">
                  <time>
                    <b>{when.label}</b>
                    <span>{when.detail}</span>
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
                            {t("event.locationOnPage")}
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
                      {statusLabel(event.status)}
                    </span>
                    {event.prize !== "Not listed" && (
                      <span className="prize">{event.prize}</span>
                    )}
                    {event.category === "adjacent" && (
                      <span className="aside-tag">{t("event.notHackathon")}</span>
                    )}
                  </div>
                </article>
              </li>
            );
          })}
          {visible.length === 0 && (
            <li className="empty">
              {inRegion.length === 0
                ? t("empty.noneOnBoard", { region: region.label })
                : t("empty.noMatch")}
            </li>
          )}
        </ol>
      </section>

      <footer>
        <p className="footer-brand">Hacklist</p>
        <p>{t("footer.tagline")}</p>
        <a href="#top">{t("footer.backToTop")}</a>
      </footer>
    </main>
  );
}
