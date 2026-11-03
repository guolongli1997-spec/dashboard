import packageJson from "../../package.json";

const currentYear = new Date().getFullYear();

export const APP_CONFIG = {
  name: "FlyTripVisa",
  version: packageJson.version,
  copyright: `© ${currentYear}, FlyTripVisa. All rights reserved.`,
  meta: {
    title: "FlyTripVisa - Global Travel Consultancy & Visa Processing Dashboard",
    description:
      "FlyTripVisa is a modern travel consultancy and visa processing management platform built with Next.js, Tailwind CSS, and shadcn/ui. Streamlining visa applications, client tracking, and travel services efficiently.",
  },
};
