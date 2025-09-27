import type { Request, Response } from 'express';
import type { IdentifyRequest , IdentifyResponse} from '../dtos/identify.dto.js';
import type {ContactRow} from '../models/Contact.js'
import { sql } from '../models/db.js';
interface InsertContactParams {
    email: string | undefined;
    phonenumber: string |undefined;
    linkprecedence: "primary" | "secondary";
    linkedid: number | undefined; 
}

async function performIdentifyLogic(data: IdentifyRequest): Promise<IdentifyResponse> {
    console.log("[performIdentifyLogic] Received request:", data);

    if (typeof data !== 'object' || data === null) {
        console.error("[performIdentifyLogic] Invalid input: not an object");
        throw { status: 400, message: 'Invalid input: request body must be an object' };
    }
const { email, phoneNumber } = data;

    if (!email && !phoneNumber) {
        throw { status: 400, message: "Either email or phoneNumber must be provided" };
    }

let contacts: ContactRow[] = [];

if (email && phoneNumber) {
    console.log("[performIdentifyLogic] Looking up by both email and phone:", email, phoneNumber);
    const result: any = await sql`
        SELECT *
        FROM contacts
        WHERE email = ${email} OR phonenumber = ${phoneNumber}
        ORDER BY createdat
    `;
    contacts = result;
} else if (email) {
    console.log("[performIdentifyLogic] Looking up by email:", email);
    const result: any = await sql`
        SELECT *
        FROM contacts
        WHERE email = ${email}
        ORDER BY createdat
    `;
    contacts = result;
} else if (phoneNumber) {
    console.log("[performIdentifyLogic] Looking up by phone number:", phoneNumber);
    const result: any = await sql`
        SELECT *
        FROM contacts
        WHERE phonenumber = ${phoneNumber}
        ORDER BY createdat
    `;
    contacts = result;
}




    console.log("[performIdentifyLogic] Found contacts:", JSON.stringify(contacts, null, 2));

    const emails = new Set<string>();
    const phoneNumbers = new Set<string>();
    const secondaryIds: number[] = [];
    for (const c of contacts) {
        if (c.email) emails.add(c.email);
        if (c.phonenumber) phoneNumbers.add(c.phonenumber); 
        if(c.linkprecedence =="secondary"){
            secondaryIds.push(c.id)
        }

    }

 const primaryId = await getPrimaryId(contacts);

const itemId = await handleContactInsertion(
    email,
    phoneNumber,
    emails,
    phoneNumbers,
    primaryId !== -1 ? primaryId : undefined
);

const response: IdentifyResponse = {
    contact: {
        primaryContactId: primaryId !== -1 ? primaryId : itemId,
        emails: Array.from(emails),
        phoneNumbers: Array.from(phoneNumbers),
        secondaryContactIds: secondaryIds
    }
};


    console.log("[performIdentifyLogic] Returning response:", response);
    return response;
}

async function resolveMultiplePrimaries(
    allRows: ContactRow[],
    allPrimaryIds: number[]
): Promise<number> {
    try {
        const idsInRows = allRows.map(c => c.id);
        const missingIds = allPrimaryIds.filter(id => !idsInRows.includes(id));

        if (missingIds.length > 0) {
            const missingRowsResult: any = await sql`
                SELECT *
                FROM contacts
                WHERE id = ANY(${missingIds}) 
            `;
            const missingRows: ContactRow[] = missingRowsResult.rows;
            allRows = allRows.concat(missingRows);
        }

        allRows.sort((a, b) => new Date(a.createdat).getTime() - new Date(b.createdat).getTime());

        if (allRows.length === 0 || !allRows[0]) return -1;

        const firstPrimaryId = allRows[0].id;

        for (let i = 1; i < allRows.length; i++) {
            const row = allRows[i];
            if (!row) continue;

            if (row.linkprecedence == 'primary') {
                await sql`
                    UPDATE contacts
                    SET linkprecedence = 'secondary',
                        linkedid = ${firstPrimaryId}
                    WHERE id = ${row.id};
                `;
            } else {
                await sql`
                    UPDATE contacts
                    SET linkedid = ${firstPrimaryId}
                    WHERE id = ${row.id};
                `;
            }
        }

        return firstPrimaryId;
    } catch (err) {
        console.error("[resolveMultiplePrimaries] Failed due to:", err);
        throw { status: 500, message: "Failed to resolve multiple primaries", error: err };
    }
}

async function getPrimaryId(contacts: ContactRow[]): Promise<number> {
    try {
        const primaryRowsIds = contacts
            .filter(c => c.linkprecedence === 'primary')
            .map(c => c.id);

        const secondaryLinkedIds = contacts
            .filter(c => c.linkprecedence === 'secondary' && c.linkedid != null)
            .map(c => c.linkedid!);

        const allPrimaryIds = Array.from(new Set([...primaryRowsIds, ...secondaryLinkedIds]));

        console.log("[getPrimaryId] Multiple primary IDs found:", allPrimaryIds);
        if (allPrimaryIds.length === 1) {
            return allPrimaryIds[0]!;
        } else if (allPrimaryIds.length > 1) {
            console.log("[getPrimaryId] Multiple primary IDs found:", allPrimaryIds);
            const primaryId = await resolveMultiplePrimaries(contacts, allPrimaryIds);
            return primaryId;
        }

        console.log("[getPrimaryId] No primary IDs found.");
        return -1;
    } catch (err) {
        console.error("[getPrimaryId] Failed due to:", err);
        throw { status: 500, message: "Failed to get primary ID", error: err };
    }
}


async function handleContactInsertion(
    inputEmail: string | undefined,
    inputPhone: string | undefined,
    emailsSet: Set<string>,
    phoneNumbersSet: Set<string>,
    primaryId: number | undefined
): Promise<number> {
    try {
        const emailExists = inputEmail ? emailsSet.has(inputEmail) : false;
        const phoneExists = inputPhone ? phoneNumbersSet.has(inputPhone) : false;

        if (!emailExists && !phoneExists) {
            console.log("[handleContactInsertion] Neither email nor phone exists → inserting as primary");
            const newId = await insertContactToDB({
                email: inputEmail,
                phonenumber: inputPhone,
                linkprecedence: "primary",
                linkedid: undefined
            });
            return newId;
        } else if((!emailExists && phoneExists) || (emailExists && !phoneExists)){
            console.log("[handleContactInsertion] Input exists → inserting as secondary linked to:", primaryId);
            const newId = await insertContactToDB({
                email: inputEmail,
                phonenumber: inputPhone,
                linkprecedence: "secondary",
                linkedid: primaryId
            });
            return newId;
        }
        else{
            console.log("[handleContactInsertion] Both email and phone exist → skipping insertion");
            return -1;
        }

    } catch (err) {
        console.error("[handleContactInsertion] Failed due to:", err);
        throw { status: 500, message: "Failed to insert contact", error: err };
    }
}

async function insertContactToDB(params: InsertContactParams): Promise<number> {
    try {
        const { email, phonenumber, linkprecedence, linkedid } = params;

        const result: any = await sql`
            INSERT INTO contacts (email, phonenumber, linkprecedence, linkedid)
            VALUES (
                ${email ?? null},
                ${phonenumber ?? null},
                ${linkprecedence},
                ${linkedid ?? null}
            )
            RETURNING id;
        `;

        return result[0].id;
    } catch (err) {
        console.error("[insertContactToDB] Failed due to:", err);
        throw { status: 500, message: "Failed to insert into DB", error: err };
    }
}


export const identifyHandler = async (req: Request, res: Response) => {
  try {
    const result = await performIdentifyLogic(req.body);
    res.json(result);
  } catch (err: any) {
    res.status(err.status ?? 500).json({ message: err.message ?? 'Internal server error' });
  }
};