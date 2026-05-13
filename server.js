require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { parse } = require("csv-parse/sync");
const cron = require("node-cron");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = "mybot123";
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = "1045432838662558";
const REMINDER_TO = "94715445396";

const CSV_URL =
  "https://docs.google.com/spreadsheets/d/1Vt7-Ls9vTIWFXWlSlNNaeuZTw0EY9TB1/export?format=csv&gid=343605832";

let lectures = [];

async function loadLectures() {
  const response = await axios.get(CSV_URL);
  const rows = parse(response.data, {
    relax_quotes: true,
    relax_column_count: true,
    skip_empty_lines: false,
  });

  lectures = extractCSELectures(rows);
  console.log("Lectures loaded:", lectures.length);
  return lectures;
}

function extractCSELectures(rows) {
  const result = [];
  let inCSE = false;
  let headerFound = false;

  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

  for (let i = 0; i < rows.length; i++) {
    const rowText = rows[i].join(" ");

    if (rowText.includes("Year 3 Semester 1") && rowText.includes("CSE")) {
      inCSE = true;
      continue;
    }

    if (inCSE && rowText.includes("Year 3 Semester 1") && rowText.includes("CIS")) {
      break;
    }

    if (inCSE && rows[i][0]?.trim().toLowerCase() === "time") {
      headerFound = true;
      continue;
    }

    if (!inCSE || !headerFound) continue;

    const startTime = rows[i][0]?.trim();
    if (!startTime || startTime.toLowerCase().includes("break")) continue;

    for (let d = 0; d < days.length; d++) {
      const colIndex = d + 1;
      const cell = rows[i][colIndex];

      if (cell && cell.trim()) {
        const parsed = parseLectureCell(cell);

        if (parsed) {
          result.push({
            program: "CSE",
            day: days[d],
            time: makeTimeRange(rows, i, colIndex),
            subject: parsed.subject,
            lecturer: parsed.lecturer,
            hall: parsed.hall,
          });
        }
      }
    }
  }

  return result;
}

function makeTimeRange(rows, startIndex, colIndex) {
  const start = rows[startIndex][0].trim().replace(".", ":");
  let end = start.split("-")[1]?.trim()?.replace(".", ":") || "";

  for (let i = startIndex + 1; i < rows.length; i++) {
    const nextTime = rows[i][0]?.trim();

    if (!nextTime || nextTime.toLowerCase().includes("break")) break;
    if (rows[i][colIndex]?.trim()) break;

    end = nextTime.split("-")[1]?.trim()?.replace(".", ":") || end;
  }

  return `${start.split("-")[0].trim()}-${end}`;
}

function parseLectureCell(cell) {
  const lines = cell
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

  if (lines.length < 2) return null;

  let subjectLine = lines[0];
  let lecturer = lines[1] || "";
  let hall = lines.slice(2).join(" ") || "-";

  let subject = subjectLine;

  if (subject.includes(" - ")) {
    subject = subject.split(" - ").slice(1).join(" - ");
  } else if (subject.includes("-")) {
    subject = subject.split("-").slice(1).join("-").trim();
  }

  subject = subject
    .replace("(Compulsory)", "")
    .replace("–", "-")
    .trim();

  return { subject, lecturer, hall };
}

function normalizeSearchText(text) {
  const shortcuts = {
    ssr: "software safety and reliability",
    spm: "software process management",
    hpc: "high performance computing",
    ml: "machine learning",
    vc: "visual computing",
    eis: "enterprise information systems",
    bi: "introduction to business intelligence",
    rm: "research methodologies",
    mc: "mobile computing",
    mcp: "mobile computing",
    spi: "social and professional issues",
  };

  return shortcuts[text.trim()] || text.trim();
}

function timeToNumber(timeRange) {
  const start = timeRange.split("-")[0].trim();
  const [hour, minute] = start.split(":").map(Number);
  return hour * 60 + minute;
}

async function sendMessage(to, msg) {
  await axios.post(
    `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      text: { body: msg },
    },
    {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

async function sendTomorrowReminder() {
  await loadLectures();

  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const tomorrow = days[(new Date().getDay() + 1) % 7];

  let reply = `🌙 Night Reminder\n\n📚 Tomorrow's Lectures (${tomorrow})\n`;
  let found = false;

  lectures.forEach((lec) => {
    if (lec.day === tomorrow) {
      found = true;
      reply += `\n📘 ${lec.subject}\n⏰ ${lec.time}\n🏫 ${lec.hall}\n👨‍🏫 ${lec.lecturer}\n`;
    }
  });

  if (!found) reply += "\nNo lectures tomorrow 🎉";

  await sendMessage(REMINDER_TO, reply);
}

cron.schedule(
  "0 20 * * *",
  async () => {
    await sendTomorrowReminder();
  },
  { timezone: "Asia/Colombo" }
);

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (message) {
      const from = message.from;
      const text = message.text?.body?.toLowerCase().trim() || "";

      await loadLectures();

      if (text.includes("schedule")) {
        let reply = "📚 CSE Year 3 Lecture Schedule\n";

        lectures.forEach((lec, index) => {
          reply += `\n${index + 1}. ${lec.subject}\n📅 ${lec.day}\n⏰ ${lec.time}\n🏫 ${lec.hall}\n👨‍🏫 ${lec.lecturer}\n`;
        });

        await sendMessage(from, reply);
      } else if (text.includes("today")) {
        const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        const today = days[new Date().getDay()];

        let reply = `📚 Today's Lectures (${today})\n`;
        let found = false;

        lectures.forEach((lec) => {
          if (lec.day === today) {
            found = true;
            reply += `\n📘 ${lec.subject}\n⏰ ${lec.time}\n🏫 ${lec.hall}\n👨‍🏫 ${lec.lecturer}\n`;
          }
        });

        if (!found) reply += "\nNo lectures today 🎉";
        await sendMessage(from, reply);
      } else if (text.includes("tomorrow")) {
        const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        const tomorrow = days[(new Date().getDay() + 1) % 7];

        let reply = `📚 Tomorrow's Lectures (${tomorrow})\n`;
        let found = false;

        lectures.forEach((lec) => {
          if (lec.day === tomorrow) {
            found = true;
            reply += `\n📘 ${lec.subject}\n⏰ ${lec.time}\n🏫 ${lec.hall}\n👨‍🏫 ${lec.lecturer}\n`;
          }
        });

        if (!found) reply += "\nNo lectures tomorrow 🎉";
        await sendMessage(from, reply);
      } else if (text.includes("next")) {
        const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        const today = days[new Date().getDay()];
        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();

        let nextLecture = null;

        lectures.forEach((lec) => {
          if (lec.day === today && timeToNumber(lec.time) > currentMinutes) {
            if (!nextLecture || timeToNumber(lec.time) < timeToNumber(nextLecture.time)) {
              nextLecture = lec;
            }
          }
        });

        if (nextLecture) {
          await sendMessage(
            from,
            `📚 Next Lecture\n\n📘 ${nextLecture.subject}\n⏰ ${nextLecture.time}\n🏫 ${nextLecture.hall}\n👨‍🏫 ${nextLecture.lecturer}`
          );
        } else {
          await sendMessage(from, "🎉 No more lectures for today");
        }
      } else {
        const searchText = normalizeSearchText(text);
        let found = false;
        let reply = "📚 Lecture Search Results\n";

        lectures.forEach((lec) => {
          if (lec.subject.toLowerCase().includes(searchText)) {
            found = true;
            reply += `\n📘 ${lec.subject}\n📅 ${lec.day}\n⏰ ${lec.time}\n🏫 ${lec.hall}\n👨‍🏫 ${lec.lecturer}\n`;
          }
        });

        if (!found) {
          await sendMessage(from, `❌ No lecture found for "${text}"`);
        } else {
          await sendMessage(from, reply);
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.log("Webhook error:", err.message);
    res.sendStatus(200);
  }
});

app.listen(3000, async () => {
  console.log("WhatsApp lecture bot running on port 3000");
  await loadLectures();
});