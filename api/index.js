import { createRequestHandler } from "@react-router/node";

export default createRequestHandler({
  build: () => import("../build/server/index.js"),
  mode: process.env.NODE_ENV,
});
