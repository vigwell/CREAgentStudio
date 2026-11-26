import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import { ScanReader } from "./ScanReader";

const api = vi.fn();
vi.mock("../api/client", () => ({ api: (...a: unknown[]) => api(...a) }));

describe("ScanReader", () => {
  it("sends the scan to /referrals/text and puts the text into the referral", async () => {
    await i18n.changeLanguage("en");
    api.mockResolvedValueOnce({ fileId: "F1", text: "כאב כתף ממושך", files: ["ref.pdf"] });
    const onText = vi.fn();
    render(<ScanReader onText={onText} />);
    const input = screen.getByLabelText("Read a scanned referral") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["%PDF"], "ref.pdf", { type: "application/pdf" })] } });
    await waitFor(() => expect(onText).toHaveBeenCalledWith("כאב כתף ממושך"));
    expect(api.mock.calls[0][0]).toBe("/referrals/text");
    expect((api.mock.calls[0][1].form as FormData).getAll("files")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toMatch(/Text read from ref.pdf \(13 characters\)/);
  });

  it("says so when the scan has no text or can't be read, and keeps the note", async () => {
    await i18n.changeLanguage("en");
    const onText = vi.fn();
    render(<ScanReader onText={onText} />);
    const input = screen.getByLabelText("Read a scanned referral") as HTMLInputElement;
    api.mockResolvedValueOnce({ fileId: "F2", text: "  ", files: ["blank.png"] });
    fireEvent.change(input, { target: { files: [new File(["x"], "blank.png")] } });
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/No text was found/));
    api.mockRejectedValueOnce(new Error("CRE refused the request (HTTP 401)"));
    fireEvent.change(input, { target: { files: [new File(["x"], "a.png")] } });
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/could not be read: CRE refused/));
    expect(onText).not.toHaveBeenCalled();
  });
});
