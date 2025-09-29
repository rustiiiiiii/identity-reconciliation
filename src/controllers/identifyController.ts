import type { Request, Response } from 'express';
import type { IdentifyRequest , IdentifyResponse} from '../dtos/identify.dto.js';
import {LinkPrecedence, type ContactRow} from '../models/Contact.js'
import { sql } from '../models/db.js';
import { all } from 'axios';
interface InsertContactParams {
    email: string | undefined;
    phonenumber: string |undefined;
    linkprecedence: "primary" | "secondary";
    linkedid: number | undefined; 
}

async function performIdentifyLogic(data: IdentifyRequest): Promise<IdentifyResponse> {
    try {
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
            contacts = result as ContactRow[];
        } else if (email) {
            console.log("[performIdentifyLogic] Looking up by email:", email);
            const result: any = await sql`
                SELECT *
                FROM contacts
                WHERE email = ${email}
                ORDER BY createdat
            `;
            contacts = result as ContactRow[];
        } else if (phoneNumber) {
            console.log("[performIdentifyLogic] Looking up by phone number:", phoneNumber);
            const result: any = await sql`
                SELECT *
                FROM contacts
                WHERE phonenumber = ${phoneNumber}
                ORDER BY createdat
            `;
            contacts = result as ContactRow[];
        }

        console.log("[performIdentifyLogic] Found contacts:", JSON.stringify(contacts, null, 2));

        const emails = new Set<string>();
        const phoneNumbers = new Set<string>();
        const secondaryIds: number[] = [];

        const { allContacts: allLinkedContacts, allPrimaryIds } = await getAllLinkedContacts(contacts);

        console.log("[performIdentifyLogic] all linked contacts:", JSON.stringify(allLinkedContacts, null, 2));


        const result = await getPrimaryId(allLinkedContacts, allPrimaryIds);

        const updatedLinkedContacts = result.allRows;
        const primaryId = result.primaryId;

        console.log("[performIdentifyLogic] Updated linked contacts:", JSON.stringify(updatedLinkedContacts, null, 2));

        for (const contact of updatedLinkedContacts) {
            if (contact.email) {
                emails.add(contact.email);
            }

            console.log("phone number");

            if (contact.phonenumber) {
                phoneNumbers.add(contact.phonenumber);
                console.log("phone number", contact.phonenumber);
            }

            if (contact.linkprecedence === LinkPrecedence.SECONDARY) {
                secondaryIds.push(contact.id);
            }
        }

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
    } catch (error) {
        console.error("[performIdentifyLogic] Error:", error);
        throw error;
    }
}


async function getAllLinkedContacts(contacts: ContactRow[]): Promise<{ allContacts: ContactRow[], allPrimaryIds: number[] }> {
  try {
    const allLinkedIds = new Set<number>();
    const existingPrimaryIds = new Set<number>();
    const missingIds = new Set<number>();
    let updatedContacts: ContactRow[] = contacts;

    for (const row of contacts) {
      if (row.linkprecedence == LinkPrecedence.SECONDARY) {
        allLinkedIds.add(row.linkedid); 
      }
      if (row.linkprecedence == LinkPrecedence.PRIMARY) {
        existingPrimaryIds.add(row.id);
      }
    }

    for (const id of allLinkedIds) {
      if (!existingPrimaryIds.has(id)) {    
        missingIds.add(id);
      }
    }

    console.log("[resolveMultiplePrimaries] Missing IDs:", [...missingIds]);

    const updatedPrimaryIds: number[] = [...new Set([...existingPrimaryIds, ...missingIds])];
    console.log(updatedPrimaryIds);

    if (missingIds.size > 0) {
      const missingRowsResult: any = await sql`
        SELECT *
        FROM contacts
        WHERE id = ANY(${[...missingIds]}) 
      `;

      const missingRows = missingRowsResult as ContactRow[]
      updatedContacts = contacts.concat(missingRows);
      console.log("[handleContactInsertion] missing rows :", JSON.stringify(missingRows, null, 2));
    }

    updatedContacts.sort((a, b) => new Date(a.createdat).getTime() - new Date(b.createdat).getTime());

    return { allContacts: updatedContacts, allPrimaryIds: updatedPrimaryIds };
  } catch (error) {
    console.error("Error in getAllLinkedContacts:", error);
    throw error;
  }
}

async function resolveMultiplePrimaries(
  allRows: ContactRow[],
): Promise<{ firstPrimaryId: number; updatedRows: ContactRow[] }> {
  try {


    if (allRows.length === 0 || !allRows[0]) return { firstPrimaryId: -1, updatedRows: [] };

    const firstPrimaryId = allRows[0].id;
    const updatedRows: ContactRow[] = [];

    for (let i = 1; i < allRows.length; i++) {
      const row = allRows[i];
      if (!row) continue;

      if (row.linkprecedence === LinkPrecedence.PRIMARY) {
        await sql`
          UPDATE contacts
          SET linkPrecedence = 'secondary',
              linkedId = ${firstPrimaryId},
              updatedAt = NOW()
          WHERE id = ${row.id};
        `;
        row.linkprecedence = LinkPrecedence.SECONDARY;
        row.linkedid = firstPrimaryId;
        updatedRows.push(row);
      }
      else if(row.linkprecedence ===LinkPrecedence.SECONDARY || row.linkedid != firstPrimaryId){

        await sql`
          UPDATE contacts
          SET linkedId = ${firstPrimaryId},
            updatedAt = NOW()
          WHERE id = ${row.id};
        `;
        row.linkedid = firstPrimaryId;
        updatedRows.push(row);

      } 
      else {

        row.linkedid = firstPrimaryId;
        updatedRows.push(row);
      }
    }

    return { firstPrimaryId, updatedRows };
  } catch (err) {
    console.error("[resolveMultiplePrimaries] Failed due to:", err);
    throw { status: 500, message: "Failed to resolve multiple primaries", error: err };
  }
}

async function getPrimaryId(contacts: ContactRow[], allPrimaryIds: number[]): Promise<{ primaryId: number; allRows: ContactRow[] }> {
    try {
       
        console.log("[getPrimaryId]  primary IDs found:", allPrimaryIds);


        let primaryId = -1;
        let updatedContacts = contacts;
        
        if (allPrimaryIds.length === 1) {
            primaryId =  allPrimaryIds[0]!;
        } else if (allPrimaryIds.length > 1) {
            console.log("[getPrimaryId] Multiple primary IDs found:", allPrimaryIds);
            const result = await resolveMultiplePrimaries(contacts);
            primaryId = result.firstPrimaryId
            updatedContacts = result.updatedRows
        }

        return {primaryId,allRows:updatedContacts};
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

    const  hasEmailInput  = inputEmail!=null
        const hasPhoneInput = inputPhone!=null
        const emailExists = hasEmailInput && emailsSet.has(inputEmail);
        const phoneExists = hasPhoneInput && phoneNumbersSet.has(inputPhone);
        
        console.log([...phoneNumbersSet])
        console.log(hasEmailInput,hasPhoneInput)
        console.log(phoneNumbersSet.has(inputPhone!))
        console.log(emailExists,phoneExists)    

        if ((!emailExists && !phoneExists) && (hasEmailInput || hasPhoneInput)) {
            console.log("[handleContactInsertion] Neither email nor phone exists → inserting as primary");
            const newId = await insertContactToDB({
                email: inputEmail,
                phonenumber: inputPhone,
                linkprecedence: "primary",
                linkedid: undefined
            });
            return newId;
        } else if((!emailExists && phoneExists && hasEmailInput) || (emailExists && !phoneExists && hasPhoneInput)){
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
            console.log("[handleContactInsertion] input exist in db -> skipping insertion");
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
            INSERT INTO contacts (email, phoneNumber, linkPrecedence, linkedId)
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