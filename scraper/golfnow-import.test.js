const assert = require("node:assert/strict");
const test = require("node:test");

const { mapTeeTimes } = require("./golfnow-import");

const course = {
  facilityId: 123,
  providerCourseId: "course-123",
  courseName: "Test Golf Club",
  googleRating: 4.5,
  googleReviews: 100,
  provider: "golfnow",
  targetUrl: "https://www.golfnow.co.uk/tee-times/facility/123",
};

function responseWithRate(rate) {
  return {
    ttResults: {
      teeTimes: [{
        time: { date: "2026-08-04T09:30:00" },
        teeTimeRates: [{
          teeTimeRateId: "rate-1",
          detailUrl: "/tee-times/123",
          singlePlayerPrice: { greensFees: { value: 30 } },
          ...rate,
        }],
      }],
    },
  };
}

test("maps an explicitly nine-hole selected GolfNow rate to 9 holes", () => {
  const [row] = mapTeeTimes(responseWithRate({
    rateName: "9 Holes",
    isNine: true,
    isEighteen: false,
  }), course);

  assert.equal(row.holes, 9);
});

test("maps an explicitly eighteen-hole selected GolfNow rate to 18 holes", () => {
  const [row] = mapTeeTimes(responseWithRate({
    rateName: "18 Holes",
    isNine: false,
    isEighteen: true,
  }), course);

  assert.equal(row.holes, 18);
});

test("maps an unknown selected GolfNow rate to null holes", () => {
  const [row] = mapTeeTimes(responseWithRate({ rateName: "Online Rate" }), course);

  assert.equal(row.holes, null);
});

test("maps contradictory selected-rate flags to null holes", () => {
  const [row] = mapTeeTimes(responseWithRate({
    isNine: true,
    isEighteen: true,
  }), course);

  assert.equal(row.holes, null);
});
