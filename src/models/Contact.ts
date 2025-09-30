
export enum LinkPrecedence {
    PRIMARY = "primary",
    SECONDARY = "secondary"
}
export interface MatchedRecord {
  linked_identifier: number |null; 
}

export interface ContactRow {
    id: number;
    email?: string;
    phoneNumber?: string;
    linkedId: number;
    linkPrecedence: LinkPrecedence;
    createdAt: Date;
    updatedAt: Date;
    deletedAt?: Date;
}
