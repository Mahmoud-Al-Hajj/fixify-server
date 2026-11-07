import { Router } from "express";
import { listDistrictsHandler } from "../controllers/districts";

export const districtsRouter = Router();

districtsRouter.get("/", listDistrictsHandler);
