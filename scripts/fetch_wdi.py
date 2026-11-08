"""Retrieval recipe for the real case study: EU-27 indicators from the World Bank World Development
Indicators (WDI), licensed CC BY 4.0 (https://datacatalog.worldbank.org/public-licenses?fragment=cc).

    python3 scripts/fetch_wdi.py [--year 2022] [--out public/examples]

Writes wdi-eu27-<year>.csv (one row per country, one column per indicator, empty = not reported)
and wdi-eu27-<year>.provenance.json with the exact API URLs, retrieval date, WDI last-updated
date and license. Values are copied unchanged; nothing is imputed here.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import urllib.request
from datetime import date

EU27 = ["AUT", "BEL", "BGR", "HRV", "CYP", "CZE", "DNK", "EST", "FIN", "FRA", "DEU", "GRC", "HUN", "IRL", "ITA", "LVA", "LTU", "LUX", "MLT", "NLD", "POL", "PRT", "ROU", "SVK", "SVN", "ESP", "SWE"]
INDICATORS = {
    "gdp_pc_ppp": ("NY.GDP.PCAP.PP.KD", "GDP per capita, PPP (constant 2021 international $)", "higher"),
    "life_expectancy": ("SP.DYN.LE00.IN", "Life expectancy at birth, total (years)", "higher"),
    "unemployment": ("SL.UEM.TOTL.ZS", "Unemployment, total (% of total labor force) (modeled ILO estimate)", "lower"),
    "co2_pc": ("EN.GHG.CO2.PC.CE.AR5", "Carbon dioxide (CO2) emissions excluding LULUCF per capita (t CO2e/capita)", "lower"),
    "internet_users": ("IT.NET.USER.ZS", "Individuals using the Internet (% of population)", "higher"),
    "tertiary_enrollment": ("SE.TER.ENRR", "School enrollment, tertiary (% gross)", "higher"),
}
API = "https://api.worldbank.org/v2/country/{countries}/indicator/{code}?date={year}&format=json&per_page=200"


def get(url: str):
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=2022)
    ap.add_argument("--out", default="public/examples")
    a = ap.parse_args()
    rows = {c: {"country_code": c} for c in EU27}
    urls = {}
    for col, (code, _, _) in INDICATORS.items():
        url = API.format(countries=";".join(EU27), code=code, year=a.year)
        urls[col] = url
        data = get(url)
        for rec in data[1] or []:
            iso = rec["countryiso3code"]
            if iso in rows:
                rows[iso]["country"] = rec["country"]["value"]
                rows[iso][col] = "" if rec["value"] is None else repr(float(rec["value"]))
    source = get("https://api.worldbank.org/v2/sources/2?format=json")[1][0]
    os.makedirs(a.out, exist_ok=True)
    name = f"wdi-eu27-{a.year}"
    header = ["country", "country_code", *INDICATORS]
    with open(os.path.join(a.out, f"{name}.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(header)
        for c in EU27:
            w.writerow([rows[c].get(h, "") for h in header])
    prov = {
        "dataset": "World Development Indicators (WDI), World Bank",
        "catalog": "https://datacatalog.worldbank.org/search/dataset/0037712/World-Development-Indicators",
        "license": "CC BY 4.0",
        "licenseUrl": "https://datacatalog.worldbank.org/public-licenses?fragment=cc",
        "attribution": "The World Bank, World Development Indicators. Underlying series credit their original compilers (UN WPP, ILO, ITU, UNESCO UIS, ICP, and others) in the WDI metadata.",
        "wdiLastUpdated": source.get("lastupdated"),
        "retrievedOn": date.today().isoformat(),
        "year": a.year,
        "countries": EU27,
        "indicators": {k: {"code": v[0], "name": v[1], "suggestedDirection": v[2], "url": urls[k]} for k, v in INDICATORS.items()},
        "changes": "Values copied unchanged from the API; one row per country; empty cells are values the API did not report for that year.",
    }
    with open(os.path.join(a.out, f"{name}.provenance.json"), "w", encoding="utf-8") as fh:
        json.dump(prov, fh, indent=2)
    print(f"wrote {name}.csv and {name}.provenance.json")


if __name__ == "__main__":
    main()
