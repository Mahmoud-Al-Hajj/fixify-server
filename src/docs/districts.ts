import { z } from "zod";
import { DISTRICT_NAMES } from "../constants/districts";
import { errors, whoCanCall } from "./components";
import { jsonResponse, type Paths } from "./convert";

export const districtsPaths: Paths = {
  "/districts": {
    get: {
      tags: ["districts"],
      operationId: "listDistricts",
      summary: "The fixed list of districts",
      description: whoCanCall(
        "anyone",
        "The only values a provider's area and the provider search area filter accept."
      ),
      responses: {
        // controllers/districts.ts listDistrictsHandler.
        200: jsonResponse(
          "The districts",
          z.object({ districts: z.array(z.enum(DISTRICT_NAMES)) })
        ),
        ...errors(),
      },
    },
  },
};
