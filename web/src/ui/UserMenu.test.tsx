import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import i18n from "../i18n";
import { UserMenu, initials, shortName } from "./UserMenu";

describe("UserMenu", () => {
  it("shows the name without the bracketed note, and initials", () => {
    expect(shortName("Faizan Aslam (Developer)")).toBe("Faizan Aslam");
    expect(shortName("dana@clinic.org")).toBe("dana@clinic.org");
    expect(initials("Faizan Aslam (Developer)")).toBe("FA");
    expect(initials("דנה לוי")).toBe("דל");
  });

  it("opens with the account, the role, the theme choice and Sign out", async () => {
    await i18n.changeLanguage("en");
    const onTheme = vi.fn();
    const onSignOut = vi.fn();
    render(<UserMenu user={{ name: "Faizan Aslam (Developer)", role: "Admin", email: "f@medilis.ai" }} theme="system" onTheme={onTheme} onSignOut={onSignOut} />);
    expect(screen.queryByText("Admin")).toBeNull(); // the role is in the menu, not in the header
    fireEvent.click(screen.getByRole("button", { name: "Account: Faizan Aslam" }));
    expect(screen.getByText("Admin")).toBeInTheDocument();
    expect(screen.getByText("f@medilis.ai")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(onTheme).toHaveBeenCalledWith("dark");
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
