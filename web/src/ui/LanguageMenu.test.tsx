import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import i18n from "../i18n";
import { LanguageMenu } from "./LanguageMenu";

describe("LanguageMenu", () => {
  it("offers the Report Engine's five languages; Arabic and Hebrew flip the page", async () => {
    await i18n.changeLanguage("en");
    render(<LanguageMenu />);
    fireEvent.click(screen.getByRole("button", { name: /Language/ }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Englishen", "Françaisfr", "עבריתhe", "العربيةar", "Españoles"]);
    fireEvent.click(screen.getByRole("option", { name: /العربية/ }));
    expect(i18n.language).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");
    await i18n.changeLanguage("fr");
    expect(document.documentElement.dir).toBe("ltr");
    await i18n.changeLanguage("en");
  });
});
