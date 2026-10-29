"use strict";

const fs = require("fs");
const path = require("path");

let cachedOpportunities = {
  timestamp: 0,
  data: null,
};

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetches opportunities from Unstop's public API.
 * @param {"hackathons"|"competitions"|"internships"|"jobs"} type
 * @param {number} perPage
 * @returns {Promise<Array<{ id: number, title: string, org: string, endDate: string, daysRemaining: number, url: string, prize: string }>>}
 */
async function fetchOpportunities(type = "hackathons", perPage = 5) {
  try {
    const url = `https://unstop.com/api/public/opportunity/search-result?opportunity=${encodeURIComponent(type)}&per_page=${perPage}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Unstop API returned status ${response.status}`);
    }

    const json = await response.json();
    const items = json?.data?.data || [];
    const now = Date.now();

    return items.map((item) => {
      const endMs = item.end_date ? Date.parse(item.end_date) : 0;
      const daysRemaining = endMs > now ? Math.ceil((endMs - now) / (1000 * 60 * 60 * 24)) : 0;
      const prizeMoney = item.prizes_and_rewards?.total_prize_money;
      const prize = prizeMoney ? `₹${prizeMoney.toLocaleString("en-IN")}` : "";

      return {
        id: item.id,
        title: item.title || "Untitled Opportunity",
        org: item.organisation?.name || item.seo_details?.sub_title || "Unstop",
        type,
        endDate: item.end_date || "",
        daysRemaining,
        url: item.public_url ? `https://unstop.com/${item.public_url.replace(/^\/+/, "")}` : "https://unstop.com",
        prize,
      };
    });
  } catch (err) {
    console.warn(`[UnstopService] Failed to fetch ${type}:`, err.message);
    return [];
  }
}

/**
 * Fetches top hackathons, competitions, and internships with caching.
 */
async function getAllFeaturedOpportunities(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedOpportunities.data && now - cachedOpportunities.timestamp < CACHE_TTL_MS) {
    return cachedOpportunities.data;
  }

  const [hackathons, competitions, internships] = await Promise.all([
    fetchOpportunities("hackathons", 4),
    fetchOpportunities("competitions", 4),
    fetchOpportunities("internships", 3),
  ]);

  const aggregated = {
    hackathons,
    competitions,
    internships,
    fetchedAt: new Date().toISOString(),
  };

  cachedOpportunities = {
    timestamp: now,
    data: aggregated,
  };

  return aggregated;
}

/**
 * Returns a clean summary string for the LLM workflow prompt.
 */
async function getUnstopSummaryText() {
  const opps = await getAllFeaturedOpportunities();
  const sections = [];

  if (opps.hackathons && opps.hackathons.length > 0) {
    const lines = opps.hackathons.map(
      (h) => `- **${h.title}** by ${h.org} (Ends in ${h.daysRemaining} days${h.prize ? ` · Prize: ${h.prize}` : ""}) → ${h.url}`
    );
    sections.push(`Active Hackathons:\n${lines.join("\n")}`);
  }

  if (opps.competitions && opps.competitions.length > 0) {
    const lines = opps.competitions.map(
      (c) => `- **${c.title}** by ${c.org} (Ends in ${c.daysRemaining} days) → ${c.url}`
    );
    sections.push(`Active Coding & Technical Contests:\n${lines.join("\n")}`);
  }

  return sections.length > 0
    ? `Live Unstop Competitions & Hackathons:\n${sections.join("\n\n")}`
    : "No active Unstop opportunities fetched.";
}

module.exports = {
  fetchOpportunities,
  getAllFeaturedOpportunities,
  getUnstopSummaryText,
};
