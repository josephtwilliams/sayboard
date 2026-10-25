export type WorkspaceSection = "board" | "devices" | "versions";
export type TeacherLocation =
  | { kind: "classrooms" }
  | { kind: "classroom"; classroomId: string }
  | {
      kind: "learner";
      classroomId: string;
      profileId: string;
      section: WorkspaceSection;
    };

const identifier =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function parseTeacherLocation(hash: string): TeacherLocation | null {
  const parts = hash.replace(/^#/, "").split("/");
  if (parts.length === 1 && !parts[0]) return { kind: "classrooms" };
  const [classroomId, profileId, section = "board"] = parts;
  if (!classroomId || !identifier.test(classroomId)) return null;
  if (parts.length === 1) return { kind: "classroom", classroomId };
  if (!profileId || !identifier.test(profileId) || parts.length > 3)
    return null;
  if (section !== "board" && section !== "devices" && section !== "versions")
    return null;
  return { kind: "learner", classroomId, profileId, section };
}

export function teacherHref(destination: TeacherLocation): string {
  if (destination.kind === "classrooms") return "/teacher";
  const classroom = `/teacher#${encodeURIComponent(destination.classroomId)}`;
  if (destination.kind === "classroom") return classroom;
  return `${classroom}/${encodeURIComponent(destination.profileId)}${destination.section === "board" ? "" : "/" + destination.section}`;
}

export function teacherEditorHref(
  classroomId: string,
  profileId: string,
): string {
  return `/?teacherBoard=${encodeURIComponent(profileId)}&classroom=${encodeURIComponent(classroomId)}`;
}
