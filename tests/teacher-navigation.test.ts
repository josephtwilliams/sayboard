import { describe, expect, it } from "vitest";
import {
  parseTeacherLocation,
  teacherHref,
  teacherEditorHref,
} from "../src/teacher-navigation";

const classroomId = "00000000-0000-4000-8000-000000000001";
const profileId = "00000000-0000-4000-8000-000000000002";

describe("teacher workspace addresses", () => {
  it("keeps previously shared classroom and learner addresses working", () => {
    expect(parseTeacherLocation("")).toEqual({ kind: "classrooms" });
    expect(parseTeacherLocation(`#${classroomId}`)).toEqual({
      kind: "classroom",
      classroomId,
    });
    expect(parseTeacherLocation(`#${classroomId}/${profileId}`)).toEqual({
      kind: "learner",
      classroomId,
      profileId,
      section: "board",
    });
  });
  it("round trips every workspace section", () => {
    for (const section of ["board", "devices", "versions"] as const) {
      const destination = {
        kind: "learner",
        classroomId,
        profileId,
        section,
      } as const;
      expect(
        parseTeacherLocation(
          new URL(teacherHref(destination), "https://example.org").hash,
        ),
      ).toEqual(destination);
    }
    expect(
      new URL(
        teacherEditorHref(classroomId, profileId),
        "https://example.org",
      ).searchParams.get("teacherBoard"),
    ).toBe(profileId);
  });
  it("rejects malformed or ambiguous addresses before requesting records", () => {
    for (const hash of [
      "#activate=private",
      "#invalid",
      `#${classroomId}/invalid`,
      `#${classroomId}/${profileId}/unknown`,
      `#${classroomId}/${profileId}/board/extra`,
    ])
      expect(parseTeacherLocation(hash)).toBeNull();
  });
});
