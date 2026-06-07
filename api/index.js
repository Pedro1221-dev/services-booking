import { createRequestListener } from "@react-router/node";

export default createRequestListener({
  build: () => import("../build/server/index.js"),
  mode: process.env.NODE_ENV,
});
