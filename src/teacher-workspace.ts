import { createElement as el } from "./dom";
import { renderSymbol } from "./symbols";
import type { ClassroomDetail, ProfileSummary } from "./classroom-contract";
import {
  teacherHref,
  teacherEditorHref,
  type WorkspaceSection,
} from "./teacher-navigation";
import "./teacher-workspace.css";

function link(label: string, href: string, className = "") {
  const anchor = el("a", className, label);
  anchor.href = href;
  return anchor;
}

/** Shared chrome for classroom management and the existing board editor. */
export function createTeacherWorkspace({
  content,
  room,
  profile,
  section,
  actions,
  feedback,
  title,
  contextAction,
}: {
  content: HTMLElement;
  room: ClassroomDetail | null;
  profile: ProfileSummary | null;
  section: WorkspaceSection;
  actions: Node[];
  feedback: HTMLElement;
  title: string;
  contextAction?: Node;
}): HTMLElement {
  const workspace = el("div", "teacher-workspace");
  const header = el("header", "workspace-header");
  const brand = link("", "/teacher", "brand");
  brand.append(renderSymbol("message-circle"), el("span", "", "sayboard"));
  const destinations = el("nav", "workspace-global");
  destinations.setAttribute("aria-label", "Teacher navigation");
  destinations.append(link("Open communication board", "/", "button quiet"));
  const oldHeader = content.querySelector(".teacher-header");
  const signOut = Array.from(oldHeader?.querySelectorAll("button") ?? []).find(
    (node) => node.textContent === "Sign out",
  );
  if (signOut) destinations.append(signOut);
  oldHeader?.remove();
  header.append(brand, destinations);

  const layout = el("div", "workspace-layout");
  const sidebar = el("nav", "workspace-sidebar");
  sidebar.setAttribute("aria-label", "Classrooms and learners");
  const classrooms = link("Your classrooms", "/teacher");
  if (!room) classrooms.setAttribute("aria-current", "page");
  sidebar.append(classrooms);
  if (room) {
    const classroom = link(
      room.name,
      teacherHref({ kind: "classroom", classroomId: room.id }),
    );
    classroom.className = "workspace-classroom";
    if (!profile) classroom.setAttribute("aria-current", "page");
    sidebar.append(classroom);
    for (const learner of room.profiles) {
      const destination = link(
        learner.label,
        teacherHref({
          kind: "learner",
          classroomId: room.id,
          profileId: learner.id,
          section: "board",
        }),
      );
      destination.className = "workspace-learner";
      if (profile?.id === learner.id)
        destination.setAttribute("aria-current", "page");
      sidebar.append(destination);
    }
    const pickerLabel = el("label", "workspace-mobile-profile", "Learner");
    const picker = el("select");
    picker.append(new Option("Choose a learner", ""));
    for (const learner of room.profiles)
      picker.append(
        new Option(
          learner.label,
          teacherHref({
            kind: "learner",
            classroomId: room.id,
            profileId: learner.id,
            section: "board",
          }),
        ),
      );
    picker.value = profile
      ? teacherHref({
          kind: "learner",
          classroomId: room.id,
          profileId: profile.id,
          section: "board",
        })
      : "";
    picker.onchange = () => {
      if (picker.value) location.assign(picker.value);
    };
    pickerLabel.append(picker);
    sidebar.append(pickerLabel);
  }
  const breadcrumbs = el("nav", "workspace-breadcrumbs");
  breadcrumbs.setAttribute("aria-label", "Location");
  breadcrumbs.append(link("Classrooms", "/teacher"));
  if (room)
    breadcrumbs.append(
      el("span", "", "/"),
      link(room.name, teacherHref({ kind: "classroom", classroomId: room.id })),
    );
  if (profile)
    breadcrumbs.append(
      el("span", "", "/"),
      room
        ? link(
            profile.label,
            teacherHref({
              kind: "learner",
              classroomId: room.id,
              profileId: profile.id,
              section: "board",
            }),
          )
        : el("span", "", profile.label),
    );
  const heading = el("h1", "", title);
  content.querySelector(":scope > h1")?.remove();
  const pageHeader = el("div", "workspace-page-header");
  const titleRow = el("div", "workspace-title-row");
  titleRow.append(heading);
  if (contextAction) titleRow.append(contextAction);
  pageHeader.append(breadcrumbs, titleRow);
  const toolbar = el("div", "workspace-toolbar");
  feedback.classList.add("workspace-feedback");
  const buttons = el("div", "workspace-actions");
  buttons.append(...actions);
  toolbar.append(feedback, buttons);
  const pageElements: Node[] = [pageHeader];
  if (profile && room) {
    const tabs = el("nav", "workspace-tabs");
    tabs.setAttribute("aria-label", "Learner workspace");
    for (const [key, label] of [
      ["board", "Board"],
      ["devices", "Devices"],
      ["versions", "Versions"],
    ] satisfies [WorkspaceSection, string][]) {
      const destination = link(
        label,
        key === "board"
          ? teacherEditorHref(room.id, profile.id)
          : teacherHref({
              kind: "learner",
              classroomId: room.id,
              profileId: profile.id,
              section: key,
            }),
      );
      if (section === key) destination.setAttribute("aria-current", "page");
      tabs.append(destination);
    }
    pageElements.push(toolbar, tabs);
  } else pageHeader.append(feedback);
  content.classList.add("workspace-main");
  content.prepend(...pageElements);
  layout.append(sidebar, content);
  workspace.append(header, layout);
  return workspace;
}
