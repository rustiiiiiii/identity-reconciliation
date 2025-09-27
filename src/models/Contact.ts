
export enum LinkPrecedence {
    PRIMARY = "primary",
    SECONDARY = "secondary"
}

export interface ContactRow {
    id: number;
    email?: string;
    phonenumber?: string;
    linkedid: number;
    linkprecedence: LinkPrecedence;
    createdat: Date;
    updatedat: Date;
    deletedat?: Date;
}