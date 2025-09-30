import type { Request, Response } from 'express';
import type { IdentifyRequest , IdentifyResponse} from '../dtos/identify.dto.js';
import {LinkPrecedence, type ContactRow, type MatchedRecord} from '../models/Contact.js'
import { isValidPhoneNumber } from 'libphonenumber-js';
import { sql } from '../models/db.js';
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

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        const hasEmail = email != null && email.trim() !== "";
        const hasPhone = phoneNumber != null && phoneNumber.trim() !== "";

        if (!hasEmail && !hasPhone) {
          throw { status: 400, message: "Either email or phoneNumber must be provided" };
        }

        if (hasEmail) {
          if (!emailRegex.test(email)) {
            throw { status: 400, message: "Invalid email format" };
          }
        }

        if (hasPhone) {
          if (!isValidPhoneNumber(phoneNumber)) {
            throw { status: 400, message: "Invalid phone number format" };
          }
        }


        let contacts: ContactRow[] = [];
        let primaryIdsResult;

        if (email && phoneNumber) {
            console.log("[performIdentifyLogic] Looking up by both email and phone:", email, phoneNumber);
            const result: any  = await sql`
                WITH MatchedRecords AS (
                    SELECT 
                        id,
                        "linkedId"
                    FROM 
                        contacts  
                    WHERE 
                        email = ${email} OR "phoneNumber" = ${phoneNumber}
                )
                SELECT DISTINCT 
                    COALESCE("linkedId", id) AS linked_identifier
                FROM 
                    MatchedRecords;

            `;
            primaryIdsResult = result as MatchedRecord[];
        } else if (email) {
            console.log("[performIdentifyLogic] Looking up by email:", email);
            const result: any  = await sql`
               WITH MatchedRecords AS (
                  SELECT 
                      id,
                      "linkedId"
                  FROM 
                      contacts  
                  WHERE 
                      email = ${email}
                    )
                SELECT DISTINCT 
                    COALESCE("linkedId", id) AS linked_identifier
                FROM 
                    MatchedRecords;

            `;
            primaryIdsResult = result as MatchedRecord[];
        } else if (phoneNumber) {
            console.log("[performIdentifyLogic] Looking up by phone number:", phoneNumber);
            const result: any = await sql`
                WITH MatchedRecords AS (
                    SELECT 
                        id,
                        "linkedId"
                    FROM 
                        contacts  
                    WHERE 
                        "phoneNumber" = ${phoneNumber}
                )
                SELECT DISTINCT 
                    COALESCE("linkedId", id) AS linked_identifier
                FROM 
                    MatchedRecords;

            `;
             primaryIdsResult = result as MatchedRecord[];
        }

        const listOfPrimaryIds: number[] = primaryIdsResult && primaryIdsResult.length > 0
        ? primaryIdsResult.map((row) => {
            const value = row.linked_identifier;
            return Number(value);
          })
        : [];
        console.log("[performIdentifyLogic] Found primary ids:", JSON.stringify(listOfPrimaryIds, null, 2));

        const emails = new Set<string>();
        const phoneNumbers = new Set<string>();
        const secondaryIds: number[] = [];

        const { allContacts: allLinkedContacts } = await getAllLinkedContacts(listOfPrimaryIds);

        console.log("[performIdentifyLogic] all linked contacts:", JSON.stringify(allLinkedContacts, null, 2));


        const result = await getPrimaryId(allLinkedContacts, listOfPrimaryIds);

        const updatedLinkedContacts = result.allRows;
        const primaryId = result.primaryId;

        console.log("[performIdentifyLogic] Updated linked contacts:", JSON.stringify(updatedLinkedContacts, null, 2));

        for (const contact of updatedLinkedContacts) {
            if (contact.email) {
                emails.add(contact.email);
            }


            if (contact.phoneNumber) {
                phoneNumbers.add(contact.phoneNumber);
            }

            if (contact.linkPrecedence === LinkPrecedence.SECONDARY) {
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


async function getAllLinkedContacts(allPrimaryIds: number[]): Promise<{ allContacts: ContactRow[]}> {
  try {
    const allLinkedIds = new Set<number>();
    const existingPrimaryIds = new Set<number>();
    const missingIds = new Set<number>();
    let updatedContacts: ContactRow[] = [];



    console.log("[resolveMultiplePrimaries] Missing IDs:", [...missingIds]);

    const updatedPrimaryIds: number[] = [...new Set([...existingPrimaryIds, ...missingIds])];
    console.log(updatedPrimaryIds);

    if (allPrimaryIds.length > 0) {
      const allLinkedRowsResult: any = await sql`
        SELECT *
        FROM contacts
        WHERE id = ANY(${[...allPrimaryIds]}) OR "linkedId" = ANY(${[...allPrimaryIds]});
      `;

      updatedContacts = allLinkedRowsResult as ContactRow[]
      console.log("[handleContactInsertion] all linked  rows :", JSON.stringify(allLinkedRowsResult, null, 2));
    }

    updatedContacts.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    return { allContacts: updatedContacts};
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

    updatedRows.push(allRows[0]) // add the 0th row (main primary row)
    // the 0th item will be the main primary item as we are choosing the older primary item.
    for (let i = 1; i < allRows.length; i++) {
      const row = allRows[i];
      if (!row) continue;

      if (row.linkPrecedence === LinkPrecedence.PRIMARY) {
        await sql`
          UPDATE contacts
          SET "linkPrecedence" = 'secondary',
              "linkedId" = ${firstPrimaryId},
              "updatedAt" = NOW()
          WHERE id = ${row.id};
        `;
        row.linkPrecedence = LinkPrecedence.SECONDARY;
        row.linkedId = firstPrimaryId;
        updatedRows.push(row);
      }
      else if(row.linkPrecedence ===LinkPrecedence.SECONDARY || row.linkedId != firstPrimaryId){

        await sql`
          UPDATE contacts
          SET "linkedId" = ${firstPrimaryId},
            "updatedAt" = NOW()
          WHERE id = ${row.id};
        `;
        row.linkedId = firstPrimaryId;
        updatedRows.push(row);

      } 
      else {

        row.linkedId = firstPrimaryId;
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


        let primaryId = -1; // if there are no primary ids for the input req
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

        const hasEmailInput = inputEmail != null && inputEmail.trim() !== "";
        const hasPhoneInput = inputPhone != null && inputPhone.trim() !== "";
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
            INSERT INTO contacts (email, "phoneNumber", "linkPrecedence", "linkedId")
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
    const status = err.status ?? 500;
    let message = err.message;

    if (status === 500 || !message) {
      message = 'Internal server error';
    }

    res.status(status).json({ message });
  }
};