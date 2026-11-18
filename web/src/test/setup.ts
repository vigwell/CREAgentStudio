import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { clearQueryCache } from "../api/query";

afterEach(() => {
  cleanup();
  clearQueryCache(); // every test starts with an empty request cache
});
