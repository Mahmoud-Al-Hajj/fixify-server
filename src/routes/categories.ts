import { Router } from "express";
import { listCategories } from "../controllers/categories";

export const categoriesRouter = Router();

categoriesRouter.get("/", listCategories);
