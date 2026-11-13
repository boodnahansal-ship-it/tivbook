export type Role = "super_admin" | "manager" | "tournament_director" | "cashier" | "floor_supervisor" | "dealer" | "front_desk";

export const ROLE_LABEL: Record<Role, [string, string]> = {
  super_admin: ["Super Administrator", "Super administrateur"],
  manager: ["Manager", "Responsable"],
  tournament_director: ["Tournament Director", "Directeur de tournoi"],
  cashier: ["Cashier", "Caissier"],
  floor_supervisor: ["Floor Supervisor", "Superviseur de salle"],
  dealer: ["Dealer", "Croupier"],
  front_desk: ["Front Desk", "Accueil"],
};

export const ALL_ROLES = Object.keys(ROLE_LABEL) as Role[];
export const can = {
  register: (r: Role) => ["super_admin", "manager", "cashier", "front_desk"].includes(r),
  viewId: (r: Role) => ["super_admin", "manager", "cashier"].includes(r),
  verifyKyc: (r: Role) => ["super_admin", "manager", "cashier"].includes(r),
};
