"""Build the Knowledge Base file source: one Markdown file per paper.

Each file carries the citation, arXiv id, and abstract, plus (where we checked
it by hand) the exact ephemeris the paper states, quoted with its table
location. The KB build reads these next to the dataset source, which is how a
disagreement between a paper and the archive row that cites it surfaces as an
issue.

  python3 scripts/kb_pack.py
"""
import html, json, re, time, urllib.parse, urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "kb" / "papers"
PAPERS = {
    # Timing catalogues and methods
    "2012.07478": "ExoClock I: the platform and Ariel target list",
    "2110.13863": "ExoClock II: 180 updated ephemerides",
    "2209.09673": "ExoClock III: 450 new ephemerides",
    "2511.14407": "ExoClock IV: 620 updated ephemerides",
    "2202.03401": "Ivshina & Winn 2022: TESS timing of hundreds of hot Jupiters",
    "1005.4415": "Eastman et al. 2010: BJD_TDB and why HJD/UTC cost minutes",
    "2508.18355": "Sodickson & Grunblatt 2025: searching for orbital decay",
    # WASP-12b, the decaying orbit
    "1602.09055": "Maciejewski 2016: departure from constant period, WASP-12b",
    "1812.02438": "Maciejewski 2018: refined decay rate, WASP-12b",
    "1911.09131": "Yee et al. 2020: the orbit of WASP-12b is decaying",
    "2012.02211": "Turner et al. 2021: decay confirmed with TESS",
    "2601.04484": "Nnaji 2026: WASP-12b ephemeris refinement with TESS",
    # Planets whose archive default is far off tonight
    "2412.04438": "Rusznak et al. 2024/2025: XO-3b among high-mass-ratio systems",
    "1201.0659": "Bakos et al. 2012: HAT-P-34b to HAT-P-37b discovery",
    "2112.04724": "A-thano et al. 2021: transit timing of HAT-P-37b",
    "1907.10078": "Borsa et al. 2019: KELT-9b parameters (archive default)",
    "1910.01607": "Wong et al. 2020: KELT-9b with TESS",
    "1702.01657": "McLeod et al. 2017: KELT-18b discovery",
    "1501.02711": "Maciejewski et al. 2014: GJ 436 system",
    "2004.09109": "Baluev et al. 2020: WASP-4 transit timing variation",
    "2107.06254": "Ellis et al. 2021: HD 97658 properties",
}

# Excerpts checked by hand against the paper's own HTML, quoted exactly.
EXCERPTS = {
    "2412.04438": (
        "Table of fitted parameters, XO-3 b column: "
        "\"T_C, Time of conjunction - 2457417: 0.98762 (+0.00011 / -0.00011)\". "
        "That is T_C = 2457417.98762 BJD_TDB. The NASA Exoplanet Archive row that cites this "
        "paper as the default solution lists pl_tranmid = 2457424.98786, which is 7.00024 days "
        "later; at a period of 3.1915 days that is not a whole number of orbits."
    ),
}

def fetch(ids):
    url = "https://export.arxiv.org/api/query?" + urllib.parse.urlencode(
        {"id_list": ",".join(ids), "max_results": len(ids)})
    return urllib.request.urlopen(url, timeout=90).read().decode()

def text(s):
    return re.sub(r"\s+", " ", html.unescape(s)).strip()

OUT.mkdir(parents=True, exist_ok=True)
ids = list(PAPERS)
feed = fetch(ids)
for e in re.findall(r"<entry>(.*?)</entry>", feed, re.S):
    aid = re.search(r"<id>http://arxiv.org/abs/(.*?)</id>", e).group(1)
    base = re.sub(r"v\d+$", "", aid)
    title = text(re.search(r"<title>(.*?)</title>", e, re.S).group(1))
    summary = text(re.search(r"<summary>(.*?)</summary>", e, re.S).group(1))
    authors = [text(a) for a in re.findall(r"<name>(.*?)</name>", e)]
    published = re.search(r"<published>(.*?)</published>", e).group(1)[:10]
    journal = re.search(r"<arxiv:journal_ref[^>]*>(.*?)</arxiv:journal_ref>", e, re.S)
    doi = re.search(r"<arxiv:doi[^>]*>(.*?)</arxiv:doi>", e, re.S)
    first = authors[0].split()[-1] if authors else "Unknown"
    cite = f"{first}{' et al.' if len(authors) > 2 else (' & ' + authors[1].split()[-1] if len(authors) == 2 else '')} ({published[:4]})"
    body = [
        f"# {title}",
        "",
        f"- Citation: {cite}, {', '.join(authors[:6])}{' and others' if len(authors) > 6 else ''}",
        f"- Role in this knowledge base: {PAPERS.get(base, '')}",
        f"- arXiv: https://arxiv.org/abs/{base}",
        f"- Journal: {text(journal.group(1)) if journal else 'preprint'}",
        f"- DOI: {text(doi.group(1)) if doi else 'none listed'}",
        f"- First posted: {published}",
        "",
        "## Abstract",
        "",
        summary,
    ]
    if base in EXCERPTS:
        body += ["", "## Ephemeris stated in the paper (quoted)", "", EXCERPTS[base]]
    (OUT / f"{base}.md").write_text("\n".join(body) + "\n")
    print("wrote", base, cite)
