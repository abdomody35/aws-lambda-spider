import puppeteer from "puppeteer-core";
import Chromium from "@sparticuz/chromium";
import { load } from "cheerio";

export const handler = async (event) => {
  try {
    const { whiteList, blackList, type, concurrency } = event;
    const baseUrl = event.url;
    const browser = await puppeteer.launch({
      args: Chromium.args,
      defaultViewport: Chromium.defaultViewport,
      executablePath: await Chromium.executablePath(),
      headless: Chromium.headless,
      ignoreHTTPSErrors: true,
    });
    const PAGE_LIMIT = 250;
    var page_count = 0;
    const visited = new Set();
    const pages = [];
    const queue = [baseUrl];
    while (queue.length > 0 && page_count < PAGE_LIMIT) {
      const batch = queue.splice(0, concurrency || 5);
      const promises = batch.map(async (url) => {
        if (visited.has(url)) return;
        visited.add(url);
        const page = await browser.newPage();
        await scrapePage({
          page,
          pages,
          uncheckedUrl: url,
          page_count,
        });
        const newLinks = await getLinks({
          page,
          baseUrl: url,
          whiteList: whiteList || [],
          blackList: blackList || [],
          type: type || "",
        });
        queue.push(...newLinks.filter((link) => !visited.has(link)));
        await page.close();
      });
      await Promise.all(promises);
    }
    await browser.close();
    const response = {
      statusCode: 200,
      body: pages,
    };
    return response;
  } catch (error) {
    console.error(error);
    const response = {
      statusCode: 500,
      body: error,
    };
    return response;
  }
};

const scrapePage = async ({ page, pages, uncheckedUrl, page_count }) => {
  const url = validateUrl(uncheckedUrl);

  if (!url) {
    return;
  }
  page.setDefaultTimeout(100000);
  let retries = 3;
  while (retries > 0) {
    try {
      await page.goto(checkHttp(url), { waitUntil: "load" });
      const html = await page.content();
      const { title, content } = await dataFromHTML(html, url);
      pages.push({ url, title: title || url, content });
      page_count++;
      return;
    } catch (error) {
      retries--;
      if (retries === 0) {
        return;
      }
    }
  }
};

const getLinks = async ({ page, baseUrl, whiteList, blackList, type }) => {
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a")).map((a) => a.href)
  );

  const validLinks = links
    .map((link) => checkRoute(link, baseUrl))
    .map(checkHttp)
    .filter((link) => isValidLink(link, baseUrl));

  switch (type) {
    case "link":
      return validLinks.filter(
        (link) =>
          (whiteList.includes(link) || !whiteList?.length) &&
          !blackList.includes(link)
      );
    case "regex":
      return validLinks.filter((link) =>
        checkRegex(link, whiteList, blackList)
      );
    case "scope":
      return validLinks.filter(
        (link) =>
          whiteList.some((scope) => link.startsWith(scope)) &&
          !blackList.some((scope) => link.startsWith(scope))
      );
    default:
      return validLinks;
  }
};

const checkRoute = (url, baseUrl) => {
  if (url.startsWith("/")) {
    return baseUrl.endsWith("/") ? baseUrl + url.slice(1) : baseUrl + url;
  }
  return url;
};

const isValidLink = (link, baseUrl) => {
  return (
    (link.startsWith(baseUrl) || link.endsWith(".pdf")) &&
    link.indexOf("#") === -1 &&
    validateUrl(link)
  );
};

const validateUrl = (url) => {
  if (!isValidUrl(url)) return false;

  return checkHttp(url);
};

const isValidUrl = (url) => {
  return url.match(
    /(https?:\/\/|[a-zA-Z0-9-]+\.)[a-zA-Z0-9-]+(\.[a-zA-Z]{2,})+(:\d+)?(\/[^\s]*)?(\?[^\s]*)?(#[^\s]*)?/gim
  );
};

const checkHttp = (url) => {
  if (!url.startsWith("http")) return "https://" + url;

  if (url.startsWith("http://")) return url.replace("http", "https");

  return url;
};

const dataFromHTML = async (html, url) => {
  const $ = load(html);
  const title = cleanup($("title").text());
  const unwanted = ["script", "style", "head"];
  unwanted.forEach((tag) => $(tag).remove()); // remove the unwanted tags
  const content = cleanup($("body").text()); // clean the data
  return { title, content };
};

const cleanup = (data) => {
  return data.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
};

const checkRegex = (link, white_list, black_list) => {
  const white_matches = white_list.filter((regex) => link.match(RegExp(regex)));
  const black_matches = black_list.filter((regex) => link.match(RegExp(regex)));
  return (
    (white_list.length === 0 || white_matches.length > 0) &&
    black_matches.length === 0
  );
};
