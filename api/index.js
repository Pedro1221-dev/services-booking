import pkg from "@react-router/node";
const { createRequestHandler } = pkg;

export default createRequestHandler({
  build: () => import("../build/server/index.js"),
  mode: process.env.NODE_ENV,
});
